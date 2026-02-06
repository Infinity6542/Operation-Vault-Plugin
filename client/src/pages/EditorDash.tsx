import { Link } from "wouter";

export default function EditorDashboard() {
	const files = [
		{ id: "1", name: "1", modified: "12-34-4567" },
		{ id: "2", name: "2", modified: "09-87-6543" },
	];

	return (
		<div className="">
			<div className="">
				<div className="">
					<h1 className="">Dashboard</h1>
				</div>
			</div>

			<div className="">
				{files.map((file) => (
					<Link href={`/edit/${file.id}`}>
						<div className="">
                            <div className="">
                                <span className="text-4xl">📄</span>
                            </div>
                            <h3 className="">{file.name}</h3>
                        </div>
					</Link>
				))}
			</div>
		</div>
	);
}
