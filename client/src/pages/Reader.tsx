import { useState, useEffect } from "react";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const md = new MarkdownIt({
	html: true,
	linkify: true,
	typographer: true,
});

export default function ReaderPage() {
	const [content, setContent] = useState(
		"# Loading...\nFetching your content. Thanks for being patient!",
	);

	useEffect(() => {
		setTimeout(() => {
			setContent("# Hello!\n\nThis is a **live** render of a note.");
		}, 500);
	}, []);

	const html = DOMPurify.sanitize(md.render(content));
	return (
		<div className="">
			<article
				className=""
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		</div>
	);
}
