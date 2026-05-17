import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const UdpPlugin = registerPlugin('UdpPlugin');

let poseLandmarker;
let currentStream;
let isRunning = false;
let socketId = null;

let lastFrameTime = 0;
let lastVideoTime = -1;

const video = document.getElementById('webcam');
const canvas = document.getElementById('output_canvas');
const canvasCtx = canvas.getContext('2d');
const videoContainer = document.getElementById('videoContainer');

const startButton = document.getElementById('startButton');
const cameraSelect = document.getElementById('cameraSelect');
const modelSelect = document.getElementById('modelSelect');
const mirrorCheckbox = document.getElementById('mirrorCheckbox');
const fpsLimitInput = document.getElementById('fpsLimit');
const ipAddressInput = document.getElementById('ipAddress');
const smoothingInput = document.getElementById('smoothing');

// --- 🌟 1. 設定の自動保存＆読み込み機能 ---

async function loadSettings() {
	const keys = ['ipAddress', 'fpsLimit', 'smoothing', 'modelSelect'];
	for (const key of keys) {
		const { value } = await Preferences.get({ key });
		if (value !== null) document.getElementById(key).value = value;
	}
	const mirror = await Preferences.get({ key: 'mirrorCheckbox' });
	if (mirror.value !== null) {
		mirrorCheckbox.checked = mirror.value === 'true';
		videoContainer.style.transform = mirrorCheckbox.checked
			? 'scaleX(-1)'
			: 'none';
	}
}

async function saveSetting(key, value) {
	await Preferences.set({ key, value: String(value) });
}

['ipAddress', 'fpsLimit', 'smoothing', 'modelSelect'].forEach((id) => {
	document
		.getElementById(id)
		.addEventListener('change', (e) => saveSetting(id, e.target.value));
});
mirrorCheckbox.addEventListener('change', (e) => {
	saveSetting('mirrorCheckbox', e.target.checked);
	videoContainer.style.transform = e.target.checked ? 'scaleX(-1)' : 'none';
});

// --- 🌟 2. OSC変換＆送信ツール ---

function createOscPositionPacket(trackerId, x, y, z) {
	const address = `/vrc/trackers/${trackerId}/position`;
	const types = ',fff';
	const align = (len) => Math.ceil((len + 1) / 4) * 4;

	const addressLen = align(address.length);
	const typesLen = align(types.length);
	const totalLen = addressLen + typesLen + 12;

	const buffer = new ArrayBuffer(totalLen);
	const view = new DataView(buffer);
	const uint8 = new Uint8Array(buffer);

	for (let i = 0; i < address.length; i++) uint8[i] = address.charCodeAt(i);
	for (let i = 0; i < types.length; i++)
		uint8[addressLen + i] = types.charCodeAt(i);

	view.setFloat32(addressLen + typesLen, x, false);
	view.setFloat32(addressLen + typesLen + 4, -y, false);
	view.setFloat32(addressLen + typesLen + 8, -z, false);

	let binaryStr = '';
	for (let i = 0; i < uint8.length; i++)
		binaryStr += String.fromCharCode(uint8[i]);
	return btoa(binaryStr);
}

let smoothedData = {};
function smoothCoordinate(id, x, y, z, strength) {
	const factor = strength / 100;
	if (!smoothedData[id]) {
		smoothedData[id] = { x, y, z };
		return { x, y, z };
	}
	smoothedData[id].x = smoothedData[id].x * factor + x * (1 - factor);
	smoothedData[id].y = smoothedData[id].y * factor + y * (1 - factor);
	smoothedData[id].z = smoothedData[id].z * factor + z * (1 - factor);
	return smoothedData[id];
}

async function sendToVRChat(trackerId, x, y, z) {
	if (!socketId) return;

	const strength = parseInt(smoothingInput.value, 10);
	const smoothed = smoothCoordinate(trackerId, x, y, z, strength);
	const base64Data = createOscPositionPacket(
		trackerId,
		smoothed.x,
		smoothed.y,
		smoothed.z,
	);

	try {
		// ★ ここが決定的なバグでした！ `data` ではなく `buffer` に修正！
		await UdpPlugin.send({
			socketId: socketId,
			address: ipAddressInput.value,
			port: 9000,
			buffer: base64Data,
		});
	} catch (e) {}
}

// --- 🌟 3. カメラとAIのメイン処理 ---

async function populateCameras() {
	try {
		const tempStream = await navigator.mediaDevices.getUserMedia({
			video: true,
		});
		tempStream.getTracks().forEach((track) => track.stop());
	} catch (e) {}

	const devices = await navigator.mediaDevices.enumerateDevices();
	const videoDevices = devices.filter(
		(device) => device.kind === 'videoinput',
	);

	cameraSelect.innerHTML = '';
	videoDevices.forEach((device, index) => {
		const option = document.createElement('option');
		option.value = device.deviceId;
		option.text = device.label || `Camera ${index + 1}`;
		cameraSelect.appendChild(option);
	});
}

// 停止処理（ボタンでToggleするため切り出し）
function stopCamera() {
	isRunning = false;
	if (currentStream) {
		currentStream.getTracks().forEach((track) => track.stop());
		currentStream = null;
	}
	video.srcObject = null;
	canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

	// ボタンを緑色に戻す
	startButton.innerText = 'Camera Start';
	startButton.style.backgroundColor = '#4CAF50';
}

async function startCamera() {
	if (!poseLandmarker) {
		alert('Loading AI...');
		return;
	}

	if (!socketId) {
		try {
			const result = await UdpPlugin.create();
			socketId = result.socketId;
			await UdpPlugin.bind({
				socketId: socketId,
				address: '0.0.0.0',
				port: 0,
			});
		} catch (e) {}
	}

	if (currentStream)
		currentStream.getTracks().forEach((track) => track.stop());
	const deviceId = cameraSelect.value;

	try {
		currentStream = await navigator.mediaDevices.getUserMedia({
			video: deviceId
				? { deviceId: { exact: deviceId } }
				: { facingMode: 'environment' },
		});
		video.srcObject = currentStream;

		// ボタンを赤色（停止用）に変える
		startButton.innerText = 'Stop Tracking';
		startButton.style.backgroundColor = '#f44336';

		if (!isRunning) {
			isRunning = true;
			predictWebcam();
		}
	} catch (error) {}
}

// モデル読み込み＆自動再起動
async function initOrUpdateModel() {
	const wasRunning = isRunning; // 今動いているかを記憶

	if (wasRunning) {
		stopCamera(); // 安全に切り替えるため、一旦カメラを止める
		startButton.innerText = 'Reloading Model...';
	}

	const level = modelSelect.value;
	const modelUrl = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${level}/float16/1/pose_landmarker_${level}.task`;

	if (!poseLandmarker) {
		const vision = await FilesetResolver.forVisionTasks(
			'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm',
		);
		poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
			baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
			runningMode: 'VIDEO',
			numPoses: 1,
		});
	} else {
		await poseLandmarker.setOptions({
			baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
		});
	}

	if (wasRunning) {
		await startCamera(); // モデル更新が終わったら自動で再開！
	}
}

async function predictWebcam() {
	if (!isRunning) return; // 停止時はループを終わらせる
	window.requestAnimationFrame(predictWebcam);

	let now = performance.now();
	let fpsInput = fpsLimitInput.value;
	if (fpsInput !== '') {
		let targetFps = parseInt(fpsInput, 10);
		if (targetFps > 0 && now - lastFrameTime < 1000 / targetFps) return;
	}
	lastFrameTime = now;

	if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
	lastVideoTime = video.currentTime;

	try {
		const results = poseLandmarker.detectForVideo(video, performance.now());

		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

		if (results.landmarks && results.worldLandmarks) {
			for (const landmark of results.landmarks) {
				for (const point of landmark) {
					canvasCtx.beginPath();
					canvasCtx.arc(
						point.x * canvas.width,
						point.y * canvas.height,
						5,
						0,
						2 * Math.PI,
					);
					canvasCtx.fillStyle = 'red';
					canvasCtx.fill();
				}
			}

			const world = results.worldLandmarks[0];
			const hipX = (world[23].x + world[24].x) / 2;
			const hipY = (world[23].y + world[24].y) / 2;
			const hipZ = (world[23].z + world[24].z) / 2;

			sendToVRChat(1, hipX, hipY, hipZ);
			sendToVRChat(2, world[27].x, world[27].y, world[27].z);
			sendToVRChat(3, world[28].x, world[28].y, world[28].z);
		}
	} catch (error) {}
}

// --- イベントリスナー ---

// ボタンを押した時のToggle（切り替え）処理
startButton.addEventListener('click', () => {
	if (isRunning) stopCamera();
	else startCamera();
});

modelSelect.addEventListener('change', initOrUpdateModel);
cameraSelect.addEventListener('change', () => {
	if (isRunning) startCamera();
});

loadSettings().then(() => {
	populateCameras();
	initOrUpdateModel();
});
