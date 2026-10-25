import { firebaseConfig, extraIceServers } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  updateProfile, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, initializeFirestore, persistentLocalCache, collection, doc, addDoc, setDoc, updateDoc,
  onSnapshot, query, orderBy, limitToLast, where, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const $ = id => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

// ---------- Setup check ----------
const setupMissing = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PASTE');
if (setupMissing) {
  show('loading', false); show('loginView'); show('setupWarn');
  $('loginBtn').disabled = true; $('signupBtn').disabled = true;
  throw new Error('Firebase config missing');
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
let db;
try { db = initializeFirestore(app, { localCache: persistentLocalCache() }); }
catch { db = getFirestore(app); }

// ---------- State ----------
let me = null, other = null, pendingName = null;
let unsubs = [];
let heartbeatTimer = null, statusTimer = null;
const nodeCache = new Map();
let firstLoad = true, stickBottom = true, lastMsgInfo = null, lastReadSentAt = 0;
const seenEl = document.createElement('div'); seenEl.className = 'seen'; seenEl.textContent = 'Seen';

// ---------- Helpers ----------
let toastTimer;
function toast(msg) {
  $('toast').textContent = msg; show('toast');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => show('toast', false), 3000);
}
const myName = () => me?.displayName || pendingName || (me?.email || '').split('@')[0];
const initial = n => (n || '?').trim().charAt(0).toUpperCase() || '?';
const fmtTime = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dayLabel(ms) {
  const d = new Date(ms), t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
function statusText(u) {
  const t = u?.lastActive?.toMillis?.();
  if (!t) return '';
  if (u.visible && Date.now() - t < 75000) return 'Online';
  const day = dayLabel(t);
  return 'Last seen ' + (day === 'Today' ? 'today' : day === 'Yesterday' ? 'yesterday' : day) + ' at ' + fmtTime(t);
}
function authError(e) {
  const c = e?.code || '';
  if (c.includes('invalid-credential') || c.includes('wrong-password') || c.includes('user-not-found')) return 'Wrong email or password.';
  if (c.includes('email-already-in-use')) return 'This email already has an account. Use Log in.';
  if (c.includes('weak-password')) return 'Password must be at least 6 characters.';
  if (c.includes('invalid-email')) return 'Please enter a valid email.';
  if (c.includes('network')) return 'No internet connection.';
  if (c.includes('too-many-requests')) return 'Too many tries. Please wait a few minutes.';
  return e?.message || 'Something went wrong.';
}

// ---------- Sounds ----------
let audioCtx = null, ringTimer = null;
document.addEventListener('pointerdown', () => {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    else if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}, { passive: true });
function tone(freq, dur, vol) {
  if (!audioCtx) return;
  try {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; g.gain.value = vol;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch {}
}
function startRing() {
  stopRing();
  const ring = () => { tone(880, 0.35, 0.15); setTimeout(() => tone(660, 0.35, 0.15), 400); navigator.vibrate?.([400, 200, 400]); };
  ring(); ringTimer = setInterval(ring, 2000);
}
function stopRing() { clearInterval(ringTimer); ringTimer = null; navigator.vibrate?.(0); }

// ---------- Auth ----------
$('loginBtn').onclick = async () => {
  $('loginErr').textContent = '';
  const email = $('emailIn').value.trim(), pass = $('passIn').value;
  if (!email || !pass) { $('loginErr').textContent = 'Enter email and password.'; return; }
  $('loginBtn').disabled = true;
  try { await signInWithEmailAndPassword(auth, email, pass); }
  catch (e) { $('loginErr').textContent = authError(e); }
  $('loginBtn').disabled = false;
};
$('signupBtn').onclick = async () => {
  $('loginErr').textContent = '';
  const name = $('nameIn').value.trim(), email = $('emailIn').value.trim(), pass = $('passIn').value;
  if (!name) { $('loginErr').textContent = 'Enter your name to create an account.'; return; }
  if (!email || !pass) { $('loginErr').textContent = 'Enter email and password.'; return; }
  $('signupBtn').disabled = true;
  pendingName = name;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(db, 'users', cred.user.uid), { name }, { merge: true }).catch(() => {});
  } catch (e) { $('loginErr').textContent = authError(e); }
  $('signupBtn').disabled = false;
};
$('passIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });

$('logoutBtn').onclick = async () => {
  if (!confirm('Log out?')) return;
  await logout();
};
async function logout() {
  endCall(true);
  stopChat();
  await signOut(auth);
}

onAuthStateChanged(auth, async user => {
  show('loading', false);
  if (!user) { me = null; stopChat(); show('chatView', false); show('loginView'); return; }
  me = user;
  try {
    await setDoc(doc(db, 'users', user.uid), {
      name: myName(), email: user.email, lastActive: serverTimestamp(), visible: true
    }, { merge: true });
  } catch (e) {
    if ((e.code || '').includes('permission-denied')) {
      $('loginErr').textContent = 'This email is not allowed to use this chat.';
    } else {
      $('loginErr').textContent = authError(e);
    }
    await signOut(auth);
    return;
  }
  show('loginView', false); show('chatView');
  startChat();
});

// ---------- Chat ----------
function startChat() {
  stopChat();
  firstLoad = true;

  // Other person + presence
  unsubs.push(onSnapshot(collection(db, 'users'), snap => {
    const others = snap.docs.filter(d => d.id !== me.uid).map(d => ({ uid: d.id, ...d.data() }));
    other = others[0] || null;
    renderHeader(); updateSeen();
  }));

  // Messages
  const q = query(collection(db, 'messages'), orderBy('createdAt'), limitToLast(300));
  unsubs.push(onSnapshot(q, renderMessages, e => toast('Could not load messages: ' + e.code)));

  // Incoming calls
  unsubs.push(onSnapshot(query(collection(db, 'calls'), where('status', '==', 'ringing')), onRingingCalls));

  heartbeat();
  heartbeatTimer = setInterval(() => { if (document.visibilityState === 'visible') heartbeat(); }, 30000);
  statusTimer = setInterval(renderHeader, 30000);
}
function stopChat() {
  unsubs.forEach(u => u()); unsubs = [];
  clearInterval(heartbeatTimer); clearInterval(statusTimer);
  nodeCache.clear(); $('msgs').replaceChildren(); other = null; lastMsgInfo = null;
}
function heartbeat() {
  if (!me) return;
  updateDoc(doc(db, 'users', me.uid), {
    lastActive: serverTimestamp(), visible: document.visibilityState === 'visible'
  }).catch(() => {});
}
document.addEventListener('visibilitychange', () => { heartbeat(); if (document.visibilityState === 'visible') markRead(); });

function renderHeader() {
  if (!other) {
    $('otherName').textContent = 'Waiting for the other person';
    $('otherStatus').textContent = 'Share the app link with them';
    $('avatar').textContent = '?';
    return;
  }
  $('otherName').textContent = other.name || 'Friend';
  $('avatar').textContent = initial(other.name);
  $('otherStatus').textContent = statusText(other);
}

const msgsEl = $('msgs');
msgsEl.addEventListener('scroll', () => {
  stickBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 120;
});

function buildMsg(m, mine) {
  const el = document.createElement('div');
  el.className = 'msg ' + (mine ? 'mine' : 'theirs') + (m.image ? ' photo' : '');
  if (m.image) {
    const img = document.createElement('img');
    img.src = m.image; img.alt = 'Photo'; img.loading = 'lazy';
    img.onload = () => { if (stickBottom) msgsEl.scrollTop = msgsEl.scrollHeight; };
    img.onclick = () => { $('viewerImg').src = m.image; show('viewer'); };
    el.appendChild(img);
  }
  if (m.text) {
    const t = document.createElement('div'); t.className = 'text'; t.textContent = m.text;
    el.appendChild(t);
  }
  const time = document.createElement('div'); time.className = 'time';
  el.appendChild(time);
  return el;
}

function renderMessages(snap) {
  if (snap.empty) {
    msgsEl.innerHTML = '<div class="empty">No messages yet.<br>Say hi! 👋</div>';
    firstLoad = false; lastMsgInfo = null; return;
  }
  const frag = document.createDocumentFragment();
  let lastDay = '', newFromOther = false, newMine = false, lastOtherMs = 0;
  snap.docs.forEach(d => {
    const m = d.data({ serverTimestamps: 'estimate' });
    const ms = m.createdAt?.toMillis?.() ?? Date.now();
    const day = dayLabel(ms);
    if (day !== lastDay) {
      const dl = document.createElement('div'); dl.className = 'day'; dl.textContent = day;
      frag.appendChild(dl); lastDay = day;
    }
    const mine = m.from === me.uid;
    let el = nodeCache.get(d.id);
    if (!el) {
      el = buildMsg(m, mine); nodeCache.set(d.id, el);
      if (!firstLoad) { if (mine) newMine = true; else newFromOther = true; }
    }
    el.querySelector('.time').textContent = fmtTime(ms);
    frag.appendChild(el);
    lastMsgInfo = { mine, ms };
    if (!mine) lastOtherMs = ms;
  });
  msgsEl.replaceChildren(frag);
  updateSeen();
  if (firstLoad || stickBottom || newMine) msgsEl.scrollTop = msgsEl.scrollHeight;
  if (newFromOther && document.visibilityState === 'visible') tone(1040, 0.12, 0.08);
  firstLoad = false;
  if (lastOtherMs > lastReadSentAt) markRead();
}

function updateSeen() {
  seenEl.remove();
  const read = other?.lastRead?.toMillis?.();
  if (lastMsgInfo?.mine && read && read >= lastMsgInfo.ms - 2000) msgsEl.appendChild(seenEl);
}
function markRead() {
  if (!me || document.visibilityState !== 'visible') return;
  lastReadSentAt = Date.now();
  updateDoc(doc(db, 'users', me.uid), { lastRead: serverTimestamp() }).catch(() => {});
}

// Send text
const textIn = $('textIn');
textIn.addEventListener('input', () => {
  textIn.style.height = 'auto';
  textIn.style.height = Math.min(textIn.scrollHeight, 120) + 'px';
});
textIn.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); sendText(); }
});
$('sendBtn').onclick = sendText;
async function sendText() {
  const text = textIn.value.trim();
  if (!text || !me) return;
  textIn.value = ''; textIn.style.height = 'auto';
  stickBottom = true;
  try { await addDoc(collection(db, 'messages'), { from: me.uid, text, createdAt: serverTimestamp() }); }
  catch (e) { toast('Message not sent. Check internet.'); textIn.value = text; }
}

// Send photo
$('photoBtn').onclick = () => $('fileIn').click();
$('fileIn').onchange = async () => {
  const file = $('fileIn').files[0];
  $('fileIn').value = '';
  if (!file || !me) return;
  show('sending');
  try {
    const image = await compressImage(file);
    stickBottom = true;
    await addDoc(collection(db, 'messages'), { from: me.uid, image, createdAt: serverTimestamp() });
  } catch (e) {
    toast('Photo not sent. Try again.');
  }
  show('sending', false);
};
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let max = 1280, q = 0.75, out = '';
    for (let i = 0; i < 7; i++) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      out = c.toDataURL('image/jpeg', q);
      if (out.length < 700000) return out; // Firestore limit is about 1 MB per message
      max = Math.round(max * 0.8); q = Math.max(0.4, q - 0.08);
    }
    if (out.length < 950000) return out;
    throw new Error('too big');
  } finally { URL.revokeObjectURL(url); }
}

// Photo viewer
$('viewer').onclick = () => { show('viewer', false); $('viewerImg').src = ''; };

// ---------- Video call (WebRTC) ----------
const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, ...extraIceServers];
let pc = null, localStream = null, callRef = null, callUnsubs = [], pendingCands = [];
let facing = 'user', ringTimeout = null, ending = false;
let incomingId = null, incomingData = null;
const handledCalls = new Set();

const getMedia = () => navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: true },
  video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } }
});
function setCallStatus(t) { $('callStatus').textContent = t; }
function showCallUI(status) {
  ['muteBtn', 'camBtn'].forEach(id => $(id).classList.remove('off'));
  facing = 'user'; $('localVideo').classList.add('mirror');
  setCallStatus(status); show('callView');
}

function newPC() {
  pc = new RTCPeerConnection({ iceServers });
  pendingCands = [];
  pc.ontrack = e => {
    const v = $('remoteVideo');
    if (v.srcObject !== e.streams[0]) { v.srcObject = e.streams[0]; v.play().catch(() => {}); }
  };
  pc.onconnectionstatechange = () => {
    const s = pc?.connectionState;
    if (s === 'connected') setCallStatus('');
    else if (s === 'disconnected') setCallStatus('Reconnecting...');
    else if (s === 'failed') { setCallStatus('Connection failed'); setTimeout(() => endCall(true), 1500); }
  };
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
}
function addRemoteCandidate(data) {
  const c = new RTCIceCandidate(data);
  if (pc?.remoteDescription) pc.addIceCandidate(c).catch(() => {});
  else pendingCands.push(c);
}
function flushCandidates() {
  pendingCands.forEach(c => pc.addIceCandidate(c).catch(() => {}));
  pendingCands = [];
}

$('callBtn').onclick = startCall;
async function startCall() {
  if (pc) return;
  if (!other) { toast('The other person has not joined yet.'); return; }
  try { localStream = await getMedia(); }
  catch { toast('Please allow camera and microphone.'); return; }
  ending = false;
  showCallUI('Calling ' + (other.name || '') + '...');
  $('localVideo').srcObject = localStream;
  newPC();
  callRef = doc(collection(db, 'calls'));
  const myCands = collection(callRef, 'callerCandidates');
  pc.onicecandidate = e => { if (e.candidate) addDoc(myCands, e.candidate.toJSON()).catch(() => {}); };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  try {
    await setDoc(callRef, {
      offer: { type: offer.type, sdp: offer.sdp }, caller: me.uid, callerName: myName(),
      status: 'ringing', createdAt: serverTimestamp()
    });
  } catch { toast('Call failed. Check internet.'); endCall(false); return; }

  callUnsubs.push(onSnapshot(callRef, async s => {
    const d = s.data();
    if (!d || !pc) return;
    if (d.answer && !pc.currentRemoteDescription) {
      clearTimeout(ringTimeout);
      setCallStatus('Connecting...');
      await pc.setRemoteDescription(d.answer);
      flushCandidates();
    }
    if (d.status === 'ended') endCall(false, d.answer ? 'Call ended' : 'Call declined');
  }));
  callUnsubs.push(onSnapshot(collection(callRef, 'calleeCandidates'), s => {
    s.docChanges().forEach(ch => { if (ch.type === 'added') addRemoteCandidate(ch.doc.data()); });
  }));
  ringTimeout = setTimeout(() => {
    if (pc && !pc.currentRemoteDescription) endCall(true, 'No answer');
  }, 45000);
}

function onRingingCalls(snap) {
  snap.docChanges().forEach(ch => {
    const id = ch.doc.id, d = ch.doc.data();
    if (ch.type === 'added' && d.caller !== me.uid && !handledCalls.has(id)) {
      const t = d.createdAt?.toMillis?.();
      if (!t || Date.now() - t > 60000) return;
      handledCalls.add(id);
      if (pc) { updateDoc(doc(db, 'calls', id), { status: 'ended' }).catch(() => {}); return; } // busy
      incomingId = id; incomingData = d;
      $('inName').textContent = d.callerName || 'Friend';
      $('inAvatar').textContent = initial(d.callerName);
      show('incoming'); startRing();
    }
    if (ch.type === 'removed' && incomingId === id) {
      incomingId = null; show('incoming', false); stopRing(); toast('Missed call');
    }
  });
}

$('declineBtn').onclick = () => {
  const id = incomingId; incomingId = null;
  show('incoming', false); stopRing();
  if (id) updateDoc(doc(db, 'calls', id), { status: 'ended' }).catch(() => {});
};

$('acceptBtn').onclick = async () => {
  const id = incomingId, d = incomingData;
  incomingId = null; show('incoming', false); stopRing();
  if (!id) return;
  callRef = doc(db, 'calls', id);
  try { localStream = await getMedia(); }
  catch { toast('Please allow camera and microphone.'); updateDoc(callRef, { status: 'ended' }).catch(() => {}); callRef = null; return; }
  ending = false;
  showCallUI('Connecting...');
  $('localVideo').srcObject = localStream;
  newPC();
  const myCands = collection(callRef, 'calleeCandidates');
  pc.onicecandidate = e => { if (e.candidate) addDoc(myCands, e.candidate.toJSON()).catch(() => {}); };
  try {
    await pc.setRemoteDescription(d.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await updateDoc(callRef, { answer: { type: answer.type, sdp: answer.sdp }, status: 'active' });
  } catch { toast('Could not connect the call.'); endCall(true); return; }
  callUnsubs.push(onSnapshot(collection(callRef, 'callerCandidates'), s => {
    s.docChanges().forEach(ch => { if (ch.type === 'added') addRemoteCandidate(ch.doc.data()); });
  }));
  callUnsubs.push(onSnapshot(callRef, s => { if (s.data()?.status === 'ended') endCall(false, 'Call ended'); }));
};

function endCall(notify, msg) {
  if (ending || (!pc && !localStream)) return;
  ending = true;
  clearTimeout(ringTimeout); stopRing();
  if (notify && callRef) updateDoc(callRef, { status: 'ended' }).catch(() => {});
  callUnsubs.forEach(u => u()); callUnsubs = [];
  if (pc) { pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null; pc.close(); pc = null; }
  localStream?.getTracks().forEach(t => t.stop()); localStream = null;
  $('localVideo').srcObject = null; $('remoteVideo').srcObject = null;
  callRef = null; show('callView', false);
  if (msg) toast(msg);
  ending = false;
}

$('hangBtn').onclick = () => endCall(true);
$('muteBtn').onclick = () => {
  const t = localStream?.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled; $('muteBtn').classList.toggle('off', !t.enabled);
  toast(t.enabled ? 'Microphone on' : 'Microphone off');
};
$('camBtn').onclick = () => {
  const t = localStream?.getVideoTracks()[0]; if (!t) return;
  t.enabled = !t.enabled; $('camBtn').classList.toggle('off', !t.enabled);
};
$('flipBtn').onclick = async () => {
  if (!localStream || !pc) return;
  facing = facing === 'user' ? 'environment' : 'user';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } } });
    const newTrack = s.getVideoTracks()[0];
    const oldTrack = localStream.getVideoTracks()[0];
    const sender = pc.getSenders().find(x => x.track && x.track.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
    if (oldTrack) { localStream.removeTrack(oldTrack); oldTrack.stop(); }
    localStream.addTrack(newTrack);
    $('localVideo').srcObject = localStream;
    $('localVideo').classList.toggle('mirror', facing === 'user');
    $('camBtn').classList.remove('off');
  } catch { toast('Could not switch camera.'); facing = facing === 'user' ? 'environment' : 'user'; }
};

window.addEventListener('pagehide', () => { if (pc && callRef) updateDoc(callRef, { status: 'ended' }).catch(() => {}); });
