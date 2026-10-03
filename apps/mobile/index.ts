import { registerRootComponent } from "expo";
/*
  The background task is defined here, at the top of the bundle, because the
  operating system starts the app without a screen to run it, and a task
  defined inside a component would not exist yet when it is asked for.
*/
import "./src/platform/background";
import { App } from "./src/shell/App";

registerRootComponent(App);
