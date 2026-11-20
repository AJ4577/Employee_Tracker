// The background location task must be registered before the app renders (and in headless starts).
import "./src/tracking";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
