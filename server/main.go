package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"embed"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"io/fs"
	"math/big"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"

	// "go.step.sm/crypto/fingerprint"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"go.uber.org/zap"
)

//go:embed embed_client/*
var embedFS embed.FS
var logger *zap.SugaredLogger
var s3Client *s3.Client

var bucketName = "opvault-test"

// * Structs
type Client struct {
	Stream   *webtransport.Stream
	PeerID   string
	Nickname string
	LastSeen time.Time
}

type Message struct {
	Type      string `json:"type"`
	ChannelID string `json:"channel_id"`
	Payload   string `json:"payload"`
	SenderID  string `json:"sender_id"`
	Nickname  string `json:"nickname,omitempty"`
}

type Hub struct {
	sync.RWMutex
	Channels map[string]map[string]*Client
}

var hub = Hub{
	Channels: make(map[string]map[string]*Client),
}

// Track file ownership: shareId -> senderId
var fileOwners = make(map[string]string)
var fileOwnersMu sync.RWMutex

// Ignore redeclared warning, test_client is only temporary
func main() {
	rawLogger, _ := zap.NewDevelopment()
	defer rawLogger.Sync()
	logger = rawLogger.Sugar()

	addr := "127.0.0.1:8080"

	tlsCert, fingerprint := certHandler()

	logger.Infof("Starting server at https://%s", addr)
	logger.Infof("Certificate hash: '%s'", fingerprint)

	logger.Info("Initialising S3 client...")
	initS3()

	mux := http.NewServeMux()

	// Setup WebTransport server
	wt := webtransport.Server{
		H3: http3.Server{
			Addr:    addr,
			Handler: mux,
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{tlsCert},
				NextProtos:   []string{"h3"},
			},
			EnableDatagrams: true,
			QUICConfig: &quic.Config{
				InitialPacketSize:       1200,
				DisablePathMTUDiscovery: true,
				EnableDatagrams:         true,
			},
		},
		CheckOrigin: func(r *http.Request) bool { return true },
	}

	// WebTransport endpoint
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		logger.Infof("Connection attempt from %s", r.RemoteAddr)
		conn, err := wt.Upgrade(w, r)
		if err != nil {
			logger.Errorf("Something went wrong while upgrading the connection to WebTransport: %s", err)
			w.WriteHeader(500)
			return
		}
		handleWebTransport(conn)
	})

	// Static file server for client
	clientFS, _ := fs.Sub(embedFS, "embed_client")
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Alt-Svc", `h3=":8080"; ma=2592000`)
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			serveIndex(w, clientFS)
		} else {
			http.FileServer(http.FS(clientFS)).ServeHTTP(w, r)
		}
	})

	// Start the server
	var wg sync.WaitGroup
	wg.Add(2)

	// HTTP/3 server
	go func() {
		defer wg.Done()
		logger.Infof("Listening on UDP %s (HTTP/3)", addr)
		if err := wt.ListenAndServe(); err != nil {
			logger.Fatal(err)
		}
	}()

	// HTTPS server (legacy support)
	go func() {
		defer wg.Done()
		logger.Infof("Listening on TCP %s (HTTPS)", addr)
		serverHTTP := &http.Server{
			Addr:      addr,
			Handler:   mux,
			TLSConfig: &tls.Config{Certificates: []tls.Certificate{tlsCert}},
		}
		if err := serverHTTP.ListenAndServeTLS("", ""); err != nil {
			logger.Fatalf("Oops, something when wrong while setting up listening: %s", err)
		}
	}()

	go cleanupLoop()

	wg.Wait()
}

// WebTransport handler
func handleWebTransport(conn *webtransport.Session) {
	logger.Infof("Session from %s accepted.", conn.RemoteAddr().String())
	defer conn.CloseWithError(0, "Closing session")

	for {
		stream, err := conn.AcceptStream(context.Background())
		if err != nil {
			logger.Errorf("Failed to accept stream: %v", err)
			return
		}

		go handleStream(stream)
	}
}

// conn *webtransport.Session is currently unused and placed in this comment instead of an argument
func handleStream(stream *webtransport.Stream) {
	defer stream.Close()

	decoder := json.NewDecoder(stream)

	var msg Message
	if err := decoder.Decode(&msg); err != nil {
		if err == io.EOF {
			logger.Errorf("Stream closed unexpectedly by client: %v", err)
		} else {
			logger.Errorf("Error decoding message: %v", err)
		}
		return
	}
	channel := msg.ChannelID

	switch msg.Type {
	case "upload":
		logger.Infof("Upload request received for file ID: %s", msg.Payload)
		multiReader := io.MultiReader(decoder.Buffered(), stream)

		rm := make([]byte, 1)
		multiReader.Read(rm)
		if rm[0] != '\n' {
			logger.Warnf("Expected newline after JSON message, got: %v", rm[0])
		}

		err := upload(multiReader, channel, msg.Payload, msg.SenderID)
		if err != nil {
			logger.Errorf("Upload failed for file ID %s: %v", msg.Payload, err)
		} else {
			fileOwnersMu.Lock()
			fileOwners[msg.Payload] = msg.SenderID
			fileOwnersMu.Unlock()
			logger.Infof("Upload successful for file ID %s (owner: %s)", msg.Payload, msg.SenderID)
		}
		return
	case "download":
		download(stream, channel, msg.Payload)
		return
	case "remove":
		fileOwnersMu.RLock()
		owner, exists := fileOwners[msg.Payload]
		fileOwnersMu.RUnlock()

		if !exists {
			owner, exists = getOwner(msg.Payload)
			if exists {
				fileOwnersMu.Lock()
				fileOwners[msg.Payload] = owner
				fileOwnersMu.Unlock()
			}
		}

		if !exists {
			logger.Warnf("No owner recorded for file %s, allowing delete", msg.Payload)
			remove(msg.Payload)
		} else if owner == msg.SenderID {
			remove(msg.Payload)
			fileOwnersMu.Lock()
			delete(fileOwners, msg.Payload)
			fileOwnersMu.Unlock()
		} else {
			logger.Warnf("Unauthorized delete attempt for file %s by %s (owner: %s)", msg.Payload, msg.SenderID, owner)
		}
		return
	case "join":
		logger.Infof("Client %s joining channel: %s", msg.SenderID, msg.ChannelID)
		hub.Lock()

		if _, ok := hub.Channels[msg.ChannelID]; !ok {
			hub.Channels[msg.ChannelID] = make(map[string]*Client)
		}

		hub.Channels[msg.ChannelID][msg.SenderID] = &Client{
			Stream:   stream,
			PeerID:   msg.SenderID,
			Nickname: msg.Nickname,
			LastSeen: time.Now(),
		}
		hub.Unlock()
		broadcastUserList(msg.ChannelID)
	default:
		broadcast(msg, stream)
	}

	for {
		if err := decoder.Decode(&msg); err != nil {
			if err == io.EOF {
				logger.Errorf("Stream closed unexpectedly by client: %v", err)
			} else {
				logger.Errorf("Error decoding message: %v", err)
			}
			break
		}

		hub.Lock()
		if clients, ok := hub.Channels[msg.ChannelID]; ok {
			if client, ok := clients[msg.SenderID]; ok {
				client.LastSeen = time.Now()
			}
		}
		hub.Unlock()

		//TODO: Improve and consolidate where logs are output.
		// Currently, some logs are handled in the switch cases while others are handled
		// within the functions. Ideally, the logs should be handled within the functions
		// I think? I'd make it easier to reuse the functions this way so I this is the
		// way to go.
		switch msg.Type {
		// Joining a share channel
		case "join":
			logger.Infof("Client %s (%s) joining channel: %s", msg.SenderID, msg.Nickname, msg.ChannelID)
			hub.Lock()

			if _, ok := hub.Channels[msg.ChannelID]; !ok {
				hub.Channels[msg.ChannelID] = make(map[string]*Client)
			}

			hub.Channels[msg.ChannelID][msg.SenderID] = &Client{
				Stream:   stream,
				PeerID:   msg.SenderID,
				LastSeen: time.Now(),
			}
			hub.Unlock()
			broadcastUserList(msg.ChannelID)
		case "message":
			logger.Infof("Message received for channel %s: %s", msg.ChannelID, msg.Payload)
			broadcast(msg, stream)
		case "heartbeat":
			// Way too annoying lol, removing the logs and doing nothing instead
			// logger.Infof("Heartbeat received from %s in channel %s", msg.SenderID, msg.ChannelID)
		case "leave":
			logger.Infof("Client %s (%s) leaving channel: %s", msg.SenderID, msg.Nickname, msg.ChannelID)
			hub.Lock()
			delete(hub.Channels[msg.ChannelID], msg.SenderID)
			hub.Unlock()
			broadcastUserList(msg.ChannelID)
			return
		default:
			logger.Infof("Message of misc type '%s' received for channel %s", msg.Type, msg.ChannelID)
			broadcast(msg, stream)
		}
	}
}

func broadcast(msg Message, sender *webtransport.Stream) {
	hub.RLock()
	defer hub.RUnlock()

	clients, ok := hub.Channels[msg.ChannelID]
	if !ok {
		logger.Warnf("No clients in channel %s to broadcast message.", msg.ChannelID)
		return
	}

	// Legacy
	// data, _ := json.Marshal(msg)

	for _, c := range clients {
		if c.Stream == sender {
			continue // Skip sender
		}
		// Legacy
		// _, err := s.Write(data)
		if err := json.NewEncoder(c.Stream).Encode(msg); err != nil {
			logger.Errorf("Error broadcasting to stream %d: %v", c.PeerID, err)
		}
	}
}

// Serve index file
func serveIndex(w http.ResponseWriter, fsys fs.FS) {
	f, _ := fsys.Open("index.html")
	defer f.Close()
	content, _ := io.ReadAll(f)
	html := string(content)
	html = strings.Replace(html, "{{BASE}}", "https://127.0.0.1:8080", 1)
	w.Header().Set("Content-Type", "text/html")
	w.Write([]byte(html))
}

// Handles server Certificates
// Generates certs if existing ones can't be found
func certHandler() (tls.Certificate, string) {
	certFile := "cert.pem"
	keyFile := "key.pem"

	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err == nil {
		// Found Certificates
		parsed, _ := x509.ParseCertificate(cert.Certificate[0])
		sha256Sum := sha256.Sum256(parsed.Raw)
		fingerprint := base64.StdEncoding.EncodeToString(sha256Sum[:])
		logger.Info("Loaded existing certificates.")
		return cert, fingerprint
	}
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{Organization: []string{"Operation Vault"}},
		NotBefore:    time.Now().Add(-24 * time.Hour),
		NotAfter:     time.Now().Add(time.Hour * 24 * 10),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	derBytes, _ := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)

	// Save certs to disk
	certOut, _ := os.Create(certFile)
	pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	certOut.Close()

	keyOut, _ := os.Create(keyFile)
	privBytes, _ := x509.MarshalECPrivateKey(priv)
	pem.Encode(keyOut, &pem.Block{Type: "EC PRIVATE KEY", Bytes: privBytes})
	keyOut.Close()

	tlsCert, _ := tls.LoadX509KeyPair(certFile, keyFile)
	sha256Sum := sha256.Sum256(derBytes)
	fingerprint := base64.StdEncoding.EncodeToString(sha256Sum[:])
	return tlsCert, fingerprint
}

func initS3() {
	cfg, err := config.LoadDefaultConfig(context.TODO())
	if err != nil {
		logger.Fatalf("Unable to load AWS SDK config, %v", err)
	}

	s3Client = s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String("https://52734793e62aadf91e3bc988c6d667cc.eu.r2.cloudflarestorage.com")
		o.Region = "auto"
		// o.UsePathStyle = true
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})

	logger.Info("S3 client initialised")
}

func upload(stream io.Reader, channel string, fileID string, ownerID string) error {
	data, err := io.ReadAll(stream)
	if err != nil {
		logger.Errorf("Failed to read data from stream: %v", err)
		return err
	}

	// if filepath.Ext(fileID) == ".yjs" {
	// 	// owner, exists := getOwner(channel)
	// 	// if exists == false {
	// 	// 	owner = ownerID
	// 	// }
	// 	_, err = s3Client.PutObject(context.TODO(), &s3.PutObjectInput{
	// 		Bucket:   aws.String(bucketName),
	// 		Key:      aws.String(channel + "/" + fileID + time.Now().Format("20060102-150405")),
	// 		Body:     bytes.NewReader(data),
	// 		Metadata: map[string]string{"owner": ownerID},
	// 	})
	// } else {
	_, err = s3Client.PutObject(context.TODO(), &s3.PutObjectInput{
		Bucket:   aws.String(bucketName),
		Key:      aws.String(channel + "/" + fileID),
		Body:     bytes.NewReader(data),
		Metadata: map[string]string{"owner": ownerID},
	})
	// }

	if err != nil {
		logger.Errorf("Failed to upload file to S3: %v", err)
		return err
	}

	logger.Infof("File %s uploaded successfully to bucket %s", fileID, bucketName)
	return nil
}

func getOwner(fileID string) (string, bool) {
	head, err := s3Client.HeadObject(context.TODO(), &s3.HeadObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(fileID + "/manifest.json"),
	})
	if err != nil {
		logger.Debugf("Failed to get metadata for file %s: %v", fileID, err)
		return "", false
	}

	if owner, ok := head.Metadata["owner"]; ok {
		logger.Debugf("Found owner %s for file %s from S3 metadata", owner, fileID)
		return owner, true
	}

	return "", false
}

func download(stream *webtransport.Stream, channel string, fileID string) error {
	logger.Infof("Downloading file %s from bucket %s", fileID, bucketName)

	out, err := s3Client.GetObject(context.TODO(), &s3.GetObjectInput{
		Bucket: aws.String(bucketName),
		Key:    aws.String(channel + "/" + fileID),
	})
	if err != nil {
		logger.Errorf("Failed to download file from S3: %v", err)
		return err
	}
	defer out.Body.Close()

	n, err := io.Copy(stream, out.Body)
	if err != nil {
		logger.Errorf("Error while sending file to client: %v", err)
		return err
	}

	logger.Infof("File %s (%d bytes) sent successfully to client", fileID, n)
	return nil
}

func remove(channelID string) error {
	listOutput, err := s3Client.ListObjectsV2(context.TODO(), &s3.ListObjectsV2Input{
		Bucket: aws.String(bucketName),
		Prefix: aws.String(channelID + "/"),
	})
	if err != nil {
		logger.Errorf("Failed to list objects for deletion: %v", err)
		return err
	}

	for _, object := range listOutput.Contents {
		_, err := s3Client.DeleteObject(context.TODO(), &s3.DeleteObjectInput{
			Bucket: aws.String(bucketName),
			Key:    object.Key,
		})
		if err != nil {
			logger.Errorf("Failed to delete object %s: %v", *object.Key, err)
		} else {
			logger.Infof("Deleted object %s", *object.Key)
		}
	}

	logger.Infof("Channel folder %s deleted successfully from bucket %s", channelID, bucketName)
	return nil
}

func cleanupLoop() error {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		hub.Lock()
		for channelID, clients := range hub.Channels {
			changed := false
			for peerID, client := range clients {
				if time.Since(client.LastSeen) <= 20*time.Second {
					continue
				}
				logger.Infof("Removing inactive client %s from channel %s", peerID, channelID)
				// client.Stream.CancelRead(0)
				delete(clients, peerID)
				changed = true
			}

			if len(clients) == 0 {
				logger.Infof("Removing empty channel %s", channelID)
				delete(hub.Channels, channelID)
				continue
			}

			if !changed {
				continue
			}

			userList := make(map[string]string)
			for _, c := range clients {
				userList[c.PeerID] = c.Nickname
			}
			listJSON, err := json.Marshal(userList)
			if err != nil {
				logger.Errorf("Failed to marshal user list: %v", err)
				continue
			}

			msg := Message{
				Type:      "user_list",
				ChannelID: channelID,
				SenderID:  "Server",
				Payload:   string(listJSON),
			}

			for _, c := range clients {
				json.NewEncoder(c.Stream).Encode(msg)
			}
		}
		hub.Unlock()
	}
	return nil
}

func broadcastUserList(channelID string) error {
	hub.RLock()
	clients := hub.Channels[channelID]
	hub.RUnlock()

	userList := make(map[string]string)
	for _, client := range clients {
		userList[client.PeerID] = client.Nickname
	}

	listJSON, err := json.Marshal(userList)
	if err != nil {
		logger.Errorf("Failed to marshal user list: %v", err)
		return err
	}

	msg := Message{
		Type:      "user_list",
		ChannelID: channelID,
		SenderID:  "Server",
		Payload:   string(listJSON),
	}

	hub.RLock()
	defer hub.RUnlock()

	for _, c := range hub.Channels[channelID] {
		if err := json.NewEncoder(c.Stream).Encode(msg); err != nil {
			logger.Errorf("Error broadcasting user list to stream %s: %v", c.PeerID, err)
			return err
		}
	}
	return nil
}
