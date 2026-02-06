import { Switch, Route } from "wouter";
import { lazy, Suspense } from "react";

import ReaderDash from "./pages/ReaderDash";
import ReaderPage from "./pages/Reader";

const EditorDash = lazy(() => import("./pages/EditorDash"));
const EditorPage = lazy(() => import("./pages/Editor"));

function App() {
	return (
		<div className="">
			<Suspense
				fallback={
					<div className="">
						Loading editor...
					</div>
				}
			>
				<Switch>
					<Route path="/" component={ReaderDash} />
          <Route path="/post/:id" component={ReaderPage}></Route>
					<Route path="/dashboard" component={EditorDash} />
					<Route path="/edit/:id" component={EditorPage} />
					<Route>404: Page not found. Try checking the URL.</Route>
				</Switch>
			</Suspense>
		</div>
	);
}
export default App;
