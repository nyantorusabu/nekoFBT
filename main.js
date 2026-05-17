import { PoseLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { registerPlugin } from '@capacitor/core';

// CapacitorのUDPプラグインを呼び出す
const UdpPlugin = registerPlugin('UdpPlugin');

let poseLandmarker;
let currentStream;
let isRunning = false;
let socketId = null; // UDP通信用のソケットID

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

// --- 🌟 OSC変換＆送信ツール（自作） ---

// 1. 文字列と数値をVRChat用のOSCバイナリに変換する関数
function createOscPositionPacket(trackerId, x, y, z) {
	const address = `/vrc/trackers/${trackerId}/position`;
	const types = ',fff'; // float（小数）が3つという意味
	const align = (len) => Math.ceil((len + 1) / 4) * 4; // OSCは4バイト区切りにするルールがある

	const addressLen = align(address.length);
	const typesLen = align(types.length);
	const totalLen = addressLen + typesLen + 12; // float(4バイト) × 3 = 12

	const buffer = new ArrayBuffer(totalLen);
	const view = new DataView(buffer);
	const uint8 = new Uint8Array(buffer);

	// アドレスと型をバイナリに書き込む
	for (let i = 0; i < address.length; i++) uint8[i] = address.charCodeAt(i);
	for (let i = 0; i < types.length; i++)
		uint8[addressLen + i] = types.charCodeAt(i);

	// X, Y, Zの座標データを書き込む（VRChatに合わせてYとZの向きを調整）
	view.setFloat32(addressLen + typesLen, x, false);
	view.setFloat32(addressLen + typesLen + 4, -y, false); // 上下反転
	view.setFloat32(addressLen + typesLen + 8, -z, false); // 前後反転

	// UDPプラグインで送れるようにBase64文字列に変換して返す
	let binaryStr = '';
	for (let i = 0; i < uint8.length; i++)
		binaryStr += String.fromCharCode(uint8[i]);
	return btoa(binaryStr);
}

// 2. スムージング（カクつき防止）処理
let smoothedData = {};
function smoothCoordinate(id, x, y, z, strength) {
	// strengthは 0(補正なし) 〜 100(動かない) の割合
	const factor = strength / 100;

	if (!smoothedData[id]) {
		smoothedData[id] = { x, y, z };
		return { x, y, z };
	}

	// 前回までの位置に、新しい位置を少しだけブレンドする（移動平均）
	smoothedData[id].x = smoothedData[id].x * factor + x * (1 - factor);
	smoothedData[id].y = smoothedData[id].y * factor + y * (1 - factor);
	smoothedData[id].z = smoothedData[id].z * factor + z * (1 - factor);
	return smoothedData[id];
}

// 3. 実際にUDPで送信する関数
async function sendToVRChat(trackerId, x, y, z) {
	if (!socketId) return; // ソケットが無ければ何もしない

	// スムージングを適用
	const strength = parseInt(smoothingInput.value, 10);
	const smoothed = smoothCoordinate(trackerId, x, y, z, strength);

	// バイナリデータを作成
	const base64Data = createOscPositionPacket(
		trackerId,
		smoothed.x,
		smoothed.y,
		smoothed.z,
	);

	try {
		await UdpPlugin.send({
			socketId: socketId,
			address: ipAddressInput.value,
			port: 9000, // VRChatのOSC受信ポート
			data: base64Data,
		});
	} catch (e) {
		// 開発中（ブラウザ上）はUDP通信できないためエラーを無視する
	}
}

// --- 終了 ---

mirrorCheckbox.addEventListener('change', (e) => {
	videoContainer.style.transform = e.target.checked ? 'scaleX(-1)' : 'none';
});

async function populateCameras() {
	try {
		const tempStream = await navigator.mediaDevices.getUserMedia({
			video: true,
		});
		tempStream.getTracks().forEach((track) => track.stop());
	} catch (e) {
		console.warn('カメラ許可待ち');
	}

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

async function initOrUpdateModel() {
	const level = modelSelect.value;
	const modelUrl = `./pose_landmarker_${level}.task`;

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
}

async function startCamera() {
	if (!poseLandmarker) {
		alert('Loading AI...');
		return;
	}

	// ★ UDP通信の準備（スマホ上で動いた時だけソケットを作る）
	if (!socketId) {
		try {
			const result = await UdpPlugin.create();
			socketId = result.socketId;
		} catch (e) {
			console.log(
				'ブラウザ環境のためUDPソケットは作成されません（スマホでのみ動作）',
			);
		}
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

		if (!isRunning) {
			isRunning = true;
			predictWebcam();
		}
		startButton.disabled = true;
		startButton.innerText = 'Tracking';
	} catch (error) {
		console.error('カメラエラー:', error);
	}
}

async function predictWebcam() {
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
			// 画面上の2D赤い点描画
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

			// ★ VRChatへのデータ送信（3D空間座標）
			const world = results.worldLandmarks[0];

			// トラッカー1: 腰 (左右のHipの中間点)
			const hipX = (world[23].x + world[24].x) / 2;
			const hipY = (world[23].y + world[24].y) / 2;
			const hipZ = (world[23].z + world[24].z) / 2;
			sendToVRChat(1, hipX, hipY, hipZ);

			// トラッカー2: 左足首
			sendToVRChat(2, world[27].x, world[27].y, world[27].z);

			// トラッカー3: 右足首
			sendToVRChat(3, world[28].x, world[28].y, world[28].z);
		}
	} catch (error) {}
}

startButton.addEventListener('click', startCamera);
modelSelect.addEventListener('change', initOrUpdateModel);
cameraSelect.addEventListener('change', () => {
	if (isRunning) startCamera();
});

populateCameras();
initOrUpdateModel();
