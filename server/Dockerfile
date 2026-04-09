FROM golang:1.25.8-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o opvault-server .

FROM alpine:latest

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /app/opvault-server .

RUN mkdir -p /app/certs

EXPOSE 8080/tcp
EXPOSE 8080/udp

CMD ["./opvault-server"]
