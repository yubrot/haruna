/**
 * Browser entry point for the haruna Web Channel.
 *
 * Derives the WebSocket URL from the current page location and renders
 * a single {@link Terminal} session panel.
 *
 * @module
 */

import { render } from "preact";
import { Terminal } from "./terminal.tsx";

const proto = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = `${proto}//${location.host}/ws`;
render(<Terminal wsUrl={wsUrl} />, document.body);
