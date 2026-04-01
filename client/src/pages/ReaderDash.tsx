import { Link } from "wouter";

export default function ReaderDash() {
	const posts = [
		{ id: 1, title: "First Post", date: "12-34-5678" },
		{ id: 2, title: "Second Post", date: "09-87-6543" },
	];

	return (
		// <div className="">
		// 	<header className="">
		// 		<h1 className="">
		// 			Notes
		// 		</h1>
		// 		<p className="">
		// 			Description
		// 		</p>
		// 	</header>
		// 	<div className="">
		// 		{posts.map((post) => (
		// 			<article key={post.id} className="">
		// 				<h3 className="">
		// 					<Link href={`/post/${post.id}`}>
		// 						<span className="" />
		// 						{post.title}
		// 					</Link>
		// 				</h3>
		// 				<div className="">
		// 					<time>{post.date}</time>
		// 				</div>
		// 			</article>
		// 		))}
		// 	</div>
		// </div>
		// This will have z-index of 0 with a slightly opaque white look
		// This is so that the blurred circles with z-index of -1 can be seen
		<div className="outline-children">
			<div className="grid gap-2 grid-cols-[1fr_5fr_1fr] grid-rows-[1fr_5fr_1fr] h-screen">
				{/* TL */}
				<div className="aspect-square"></div>
				{/* TC */}
				<div className="flex justify-center content-center">
          <div className="flex"><p>LOGO</p></div>
        </div>
				{/* TR */}
				<div className="aspect-square"></div>
				{/* ML */}
				<div className=""></div>
				{/* MC */}
				<div className=""></div>
				{/* MR */}
				<div className=""></div>
				{/* BL */}
				<div className="aspect-square"></div>
				{/* BC */}
				<div className=""></div>
				{/* BR */}
				<div className="aspect-square"></div>
			</div>
		</div>
	);
}
