/**
 * Sidepanel bootstrap: Shoelace setup, mount the app, kick off initial loads
 * and the connection-status poll.
 */
import "./sidepanel.css";
import { setupShoelace } from "../shared/setup.js";
import { ensureConnection } from "../shared/api.js";
import { store } from "./store.js";
import { mountApp } from "./components/App.js";

setupShoelace();

const root = document.getElementById("app");
if (!root) throw new Error('Missing #app root element.');
mountApp(root);

const actions = store.getState();
ensureConnection();
void actions.loadServers();
void actions.refreshHostStatus();
void actions.loadPairing();
void actions.pollConnection();

setInterval(() => void store.getState().pollConnection(), 3000);
