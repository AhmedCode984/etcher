/** This function will :
 * 	- start the ipc server (api)
 *  - spawn the child process (privileged or not)
 *  - wait for the child process to connect to the api
 *  - return a promise that will resolve with the emit function for the api
 *
 * //TODO:
 *  - this should be refactored to reverse the control flow:
 *    - the child process should be the server
 *    - this should be the client
 *  - replace the current node-ipc api with a websocket api
 *  - centralise the api for both the writer and the scanner instead of having two instances running
 */

import WebSocket from 'ws'; // (no types for wrapper, this is expected)
import { spawn } from 'child_process';
import * as os from 'os';
import * as packageJSON from '../../../../package.json';
import * as permissions from '../../../shared/permissions';
import * as errors from '../../../shared/errors';

const THREADS_PER_CPU = 16;
const connectionRetryDelay = 1000;
const connectionRetryAttempts = 10;

type ApiChannel = {
	emit?: (type: string, payload: any) => void;
	registerHandler?: (event: string, handler: any) => void;
	cancelled?: boolean;
};

async function writerArgv(): Promise<string[]> {
	let entryPoint = await window.etcher.getEtcherUtilPath();
	// AppImages run over FUSE, so the files inside the mount point
	// can only be accessed by the user that mounted the AppImage.
	// This means we can't re-spawn Etcher as root from the same
	// mount-point, and as a workaround, we re-mount the original
	// AppImage as root.
	if (os.platform() === 'linux' && process.env.APPIMAGE && process.env.APPDIR) {
		entryPoint = entryPoint.replace(process.env.APPDIR, '');
		return [
			process.env.APPIMAGE,
			'-e',
			`require(\`\${process.env.APPDIR}${entryPoint}\`)`,
		];
	} else {
		return [entryPoint];
	}
}

async function spawnChild({
	withPrivileges,
	ETCHER_SERVER_ID,
	ETCHER_SERVER_ADDRESS,
	ETCHER_SERVER_PORT,
}: {
	withPrivileges: boolean;
	ETCHER_SERVER_ID: string;
	ETCHER_SERVER_ADDRESS: string;
	ETCHER_SERVER_PORT: string;
}) {
	const argv = await writerArgv();
	const env: any = {
		ETCHER_SERVER_ADDRESS,
		ETCHER_SERVER_ID,
		ETCHER_SERVER_PORT,
		UV_THREADPOOL_SIZE: (os.cpus().length * THREADS_PER_CPU).toString(),
		// This environment variable prevents the AppImages
		// desktop integration script from presenting the
		// "installation" dialog
		SKIP: '1',
		...(process.platform === 'win32' ? {} : process.env),
	};

	console.log(env);

	if (withPrivileges) {
		console.log('... with privileges ...');
		return permissions.elevateCommand(argv, {
			applicationName: packageJSON.displayName,
			env,
		});
	} else {
		const process = await spawn(argv[0], argv.slice(1), {
			env,
		});
		return { cancelled: false, process };
	}
}

const connectToChildProcess = async ({
	ETCHER_SERVER_ADDRESS,
	ETCHER_SERVER_PORT,
	ETCHER_SERVER_ID,
}: any): Promise<any> =>
	new Promise((resolve, reject) => {
		console.log(ETCHER_SERVER_ID);

		// TODO: default to IPC connections https://github.com/websockets/ws/blob/master/doc/ws.md#ipc-connections
		// TOOD: use the path as cheap authentication
		const url = `ws://${ETCHER_SERVER_ADDRESS}:${ETCHER_SERVER_PORT}`;

		const ws = new WebSocket(url);

		let heartbeat: any;

		const startHeartbeat = (emit: any) => {
			console.log('start heartbeat');
			heartbeat = setInterval(() => {
				emit('heartbeat', {});
			}, 1000);
		};

		const stopHeartbeat = () => {
			console.log('stop heartbeat');
			clearInterval(heartbeat);
		};

		ws.on('error', (error: any) => {
			if (error.code === 'ECONNREFUSED') {
				resolve({ failed: true, emit: null, registerHandler: null });
			} else {
				stopHeartbeat();
				reject(error);
			}
		});

		ws.on('open', () => {
			const emit = (type: string, payload: any) => {
				ws.send(JSON.stringify({ type, payload }));
			};

			emit('ready', {});

			// parse and route messages
			const messagesHandler: any = {
				log: (message: any) => {
					console.log(`CHILD LOG: ${message}`);
				},

				error: (error: any) => {
					const errorObject = errors.fromJSON(error);
					console.error('CHILD ERROR', errorObject);
					stopHeartbeat();
				},

				// once api is ready (means child process is connected) we pass the emit function to the caller
				ready: () => {
					console.log('CHILD READY');

					startHeartbeat(emit);

					resolve({
						failed: false,
						emit,
						registerHandler,
					});
				},
			};

			ws.on('message', (jsonData: any) => {
				const data = JSON.parse(jsonData);
				const message = messagesHandler[data.type];
				if (message) {
					message(data.payload);
				} else {
					throw new Error(`Unknown message type: ${data.type}`);
				}
			});

			// api to register more handlers with callbacks
			const registerHandler = (event: string, handler: any) => {
				messagesHandler[event] = handler;
			};
		});
	});

async function spawnChildAndConnect({
	withPrivileges,
}: {
	withPrivileges: boolean;
}): Promise<ApiChannel> {
	const ETCHER_SERVER_ADDRESS =
		process.env.ETCHER_SERVER_ADDRESS ?? '127.0.0.1'; // localhost
	const ETCHER_SERVER_PORT =
		process.env.ETCHER_SERVER_PORT ?? withPrivileges ? '3435' : '3434';
	const ETCHER_SERVER_ID =
		process.env.ETCHER_SERVER_ID ??
		`etcher-${Math.random().toString(36).substring(7)}`;

	console.log('will spawn child', ETCHER_SERVER_PORT, withPrivileges);

	// spawn the child process, which will act as the ws server
	// ETCHER_NO_SPAWN_UTIL can be set to launch a GUI only version of etcher, in that case you'll probably want to set other ENV to match your setup
	if (!process.env.ETCHER_NO_SPAWN_UTIL) {
		try {
			const result = await spawnChild({
				withPrivileges,
				ETCHER_SERVER_ADDRESS,
				ETCHER_SERVER_PORT,
				ETCHER_SERVER_ID,
			});
			if (result.cancelled) {
				return { cancelled: true };
			}
		} catch (error) {
			console.error('Error spawning child process', error);
			return { cancelled: true };
		}
	}

	// try to connect to the ws server, retrying if necessary, until the connection is established
	try {
		let retry = 0;
		while (retry < connectionRetryAttempts) {
			const { emit, registerHandler, failed } = await connectToChildProcess({
				ETCHER_SERVER_ADDRESS,
				ETCHER_SERVER_PORT,
				ETCHER_SERVER_ID,
			});
			if (failed) {
				retry++;
				console.log(
					`Retrying to connect to child process in ${connectionRetryDelay}... ${retry} / ${connectionRetryAttempts}`,
				);
				await new Promise((resolve) =>
					setTimeout(resolve, connectionRetryDelay),
				);
				continue;
			}
			return { emit, registerHandler };
		}
		throw new Error('Connection to etcher-util timed out');
	} catch (error) {
		console.error('Error connecting to child process', error);
		return { cancelled: true };
	}
}

export { spawnChildAndConnect };
