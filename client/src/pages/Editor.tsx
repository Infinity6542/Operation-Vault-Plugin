import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";

export default function EditorPage() {
    const editorRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!editorRef.current) return;

        const state = EditorState.create({
            doc: "# The Editor!\n\nBegin typing :D",
            extensions: [
                basicSetup,
                markdown(),
                EditorView.lineWrapping,
                EditorView.theme({
                    "&": { height: "100vh"},
                    ".cm-content": { fontFamily: "ui-monospace, monospace"}
                })
            ],
        });

        const view = new EditorView({
            state,
            parent: editorRef.current,
        });

        return () => {
            view.destroy();
        }
    })
	return (
		<div className="">
            <div ref={editorRef} className=""></div>
        </div>
	);
}