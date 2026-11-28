import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, collection, doc, query, where, onSnapshot, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { firebaseConfig, ADMIN_UID, VAPID_KEY } from "./config.js";

const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
const db = getFirestore(fb);

const AVATARS = ["👤","🐱","🐶","🦊","🦁","🐼","🐨","🐻","🐰","🐸","🐵","🐧","🐦","🦖","🦄","✏️","📐","📚","🎒","🎓","🧪","🎨","🎺","🎸","💻","⚽","🏀","⚾","🎾","🏐","🏓","🏸","🏃","💃","🎮","🕹️","🎧","🎬","📸","🔮","🛹","🚀","🛸","✈️","🏎️","🔥","⚡","🌟","🌈","👑"];
const CATEGORIES = [["all","すべて"],["予定","予定"],["宿題","宿題"],["連絡事項","連絡"]];
const REACTIONS = [["like","👍 いいね"],["checked","👀 確認した"],["thanks","🙏 ありがとう"]];
const TARGET = { "両方": "全体", "7-1": "7-1組", "7-2": "7-2組" };

/* ---------- 小さな道具 ---------- */
const $ = id => document.getElementById(id);
// 入力された文字は必ずテキストとして入れる（HTMLとして解釈させない）
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k.startsWith("aria-") || k === "role") el.setAttribute(k, v);
    else el[k] = v;
  }
  el.append(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
  return el;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動く */ } }
};
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const millis = v => v?.toMillis ? v.toMillis() : (v ? new Date(v).getTime() : Date.now());
const when = v => new Date(millis(v)).toLocaleString("ja-JP", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" });

let toastTimer;
function toast(msg) {
  const t = $("toast");
  // ダイアログを開いていても手前に表示する
  (document.querySelector("dialog[open]") || document.body).append(t);
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
function friendly(e) {
  const map = {
    "auth/invalid-credential":"メールアドレスかパスワードが違います。","auth/wrong-password":"メールアドレスかパスワードが違います。","auth/user-not-found":"メールアドレスかパスワードが違います。",
    "auth/invalid-email":"メールアドレスの形式が正しくありません。","auth/email-already-in-use":"このメールアドレスは登録済みです。「ログイン」を押してください。",
    "auth/weak-password":"パスワードは6文字以上にしてください。","auth/too-many-requests":"回数が多すぎます。しばらくしてからお試しください。",
    "auth/popup-closed-by-user":"ログインがキャンセルされました。","auth/cancelled-popup-request":"ログインがキャンセルされました。","auth/popup-blocked":"ポップアップを許可してください。",
    "auth/network-request-failed":"通信できません。電波を確認してください。","auth/account-exists-with-different-credential":"別のログイン方法で登録されています。",
    "permission-denied":"この操作はできません。","unavailable":"通信できません。電波を確認してください。"
  };
  return map[e?.code] || "うまくいきませんでした。もう一度お試しください。";
}
// 二重送信を防ぎつつ実行する
async function run(button, errorId, fn) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  if (errorId) $(errorId).textContent = "";
  try { await fn(); }
  catch (e) { console.error(e); const m = e.userMessage || friendly(e); errorId ? $(errorId).textContent = m : toast(m); }
  finally { if (button) button.disabled = false; }
}
const fail = userMessage => { throw Object.assign(new Error(userMessage), { userMessage }); };

/* ---------- テーマ色（この端末に保存） ---------- */
const THEMES = [["blue","ブルー"],["green","グリーン"],["purple","パープル"],["pink","ピンク"],["orange","オレンジ"],["gray","グラファイト"]];
function applyTheme(id) {
  const theme = THEMES.some(t => t[0] === id) ? id : "blue";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  $("themeGrid").replaceChildren(...THEMES.map(([key, label]) => h("button", { type: "button", role: "radio", class: "swatch", "aria-checked": String(key === theme),
    onclick: () => { store.set("theme", key); applyTheme(key); } }, h("i", { class: "dot-" + key }), label)));
}
applyTheme(store.get("theme"));

/* ---------- 状態 ---------- */
let user = null, isAdmin = false, me = null, view = "loading";
let gateSubs = [], appSubs = [], appKey = "";
let posts = [], members = {}, tags = [], reminders = [], announcements = [], inbox = [], settings = {};
let current = new Date(), category = "all", wantedPost = new URLSearchParams(location.hash.slice(1)).get("post");
const groups = new Map();
let postsLoaded = false;
const cards = new Map(); // postId -> { el, subs, ... }

function show(name) {
  view = name;
  $("gate").hidden = name === "app";
  $("app").hidden = name !== "app";
  document.querySelectorAll("[data-view]").forEach(v => v.hidden = v.dataset.view !== name);
}

/* ---------- ログインと承認 ---------- */
onAuthStateChanged(auth, u => {
  // 別の人に切り替わったら画面を丸ごと作り直す（前の人の権限や表示を残さない）
  if (user && (!u || u.uid !== user.uid)) { location.reload(); return; }
  if (!u) { show("login"); return; }
  if (user) return;
  user = u; isAdmin = u.uid === ADMIN_UID;
  if (isAdmin) { me = { name: "管理者", avatar: "👑", classId: "管理" }; startApp(); return; }
  show("loading");
  const got = {};
  const decide = () => {
    if (!("s" in got && "m" in got && "r" in got)) return;
    if (got.s) { stopApp(); show("suspended"); }
    else if (got.m) {
      if (view === "pending") toast("アカウントが承認されました");
      me = got.m; startApp();
    }
    else { stopApp(); show(got.r ? "pending" : "setup"); }
  };
  gateSubs = [["s","suspended"],["m","members"],["r","requests"]].map(([key, col]) =>
    onSnapshot(doc(db, col, u.uid), s => { got[key] = s.exists() ? s.data() : null; decide(); },
      e => { console.error(e); toast(friendly(e)); }));
});

$("authForm").addEventListener("submit", e => {
  e.preventDefault();
  const register = e.submitter?.value === "register";
  run(e.submitter, "authError", async () => {
    await (register ? createUserWithEmailAndPassword : signInWithEmailAndPassword)(auth, $("email").value.trim(), $("password").value);
  });
});
$("googleLogin").onclick = e => run(e.currentTarget, "authError", () => signInWithPopup(auth, new GoogleAuthProvider()));
$("resetPassword").onclick = e => run(e.currentTarget, "authError", async () => {
  const email = $("email").value.trim();
  if (!email) fail("メールアドレスを入力してから押してください。");
  await sendPasswordResetEmail(auth, email);
  toast("登録がある場合、再設定メールが届きます");
});

$("setupForm").addEventListener("submit", e => {
  e.preventDefault();
  run(e.submitter, "setupError", async () => {
    const name = $("setupName").value.trim();
    if (!name) fail("名前を入力してください。");
    try {
      await setDoc(doc(db, "requests", user.uid), {
        name, classId: $("setupClass").value, avatar: "👤", code: $("setupCode").value.trim().toUpperCase(),
        loginId: user.email, agreedAt: serverTimestamp()
      });
    } catch (err) {
      if (err.code === "permission-denied") fail("招待コードが違います。管理者に確認してください。");
      throw err;
    }
    await tellAdmin("request");
  });
});

$("appealForm").addEventListener("submit", e => {
  e.preventDefault();
  run(e.submitter, "appealError", async () => {
    const reason = $("appealReason").value.trim();
    if (!reason) fail("理由を入力してください。");
    try { await setDoc(doc(db, "appeals", user.uid), { reason, createdAt: serverTimestamp() }); }
    catch (err) { if (err.code === "permission-denied") fail("すでに送信されています。管理者の確認をお待ちください。"); throw err; }
    e.target.reset(); toast("異議申し立てを送信しました");
  });
});

async function logout() {
  const token = store.get("pushToken");
  if (token) { try { await deleteDoc(doc(db, "pushTokens", token)); } catch (e) { console.warn(e); } store.set("pushToken", ""); }
  await signOut(auth);
}
document.querySelectorAll("[data-logout]").forEach(b => b.onclick = () => run(b, null, logout));

// 管理者への通知。失敗しても本体の操作は成功扱いにする
async function tellAdmin(type, postId = "") {
  if (isAdmin) return;
  try { await addDoc(collection(db, "adminInbox"), { type, uid: user.uid, postId, createdAt: serverTimestamp(), pushed: false }); }
  catch (e) { console.warn(e); }
}

/* ---------- メイン画面 ---------- */
function stopApp() {
  appSubs.forEach(f => f()); appSubs = []; appKey = "";
  cards.forEach(c => c.subs.forEach(f => f())); cards.clear();
  $("posts").replaceChildren(); groups.clear(); postsLoaded = false;
  confirms.forEach(v => v.off()); confirms.clear();
  posts = []; announcements = []; inbox = []; $("loadError").textContent = "";
  document.querySelectorAll("dialog[open]").forEach(d => d.close());
}

function listen(ref, fn) {
  appSubs.push(onSnapshot(ref, fn, e => { console.error(e); $("loadError").textContent = "一部の情報を読み込めませんでした。" + friendly(e); }));
}
const list = s => s.docs.map(d => ({ id: d.id, ...d.data() }));

function startApp() {
  const key = isAdmin ? "admin" : me.classId;
  const first = view !== "app";
  if (appKey !== key) {
    stopApp(); appKey = key;
    const mine = where("classTarget", "in", ["両方", me.classId]);
    listen(isAdmin ? collection(db, "posts") : query(collection(db, "posts"), mine), s => {
      postsLoaded = true;
      posts = list(s).sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
      renderPosts(); renderNotices(s);
      if (wantedPost && posts.some(p => p.id === wantedPost)) { const id = wantedPost; wantedPost = null; goToPost(id); }
    });
    listen(collection(db, "members"), s => {
      members = Object.fromEntries(list(s).map(m => [m.id, m]));
      cards.forEach(c => { drawComments(c); drawStatus(c); }); if (isAdmin) { renderDashboard(); renderNotices(); }
    });
    listen(collection(db, "tags"), s => { tags = list(s); renderTags(); renderPosts(); });
    listen(doc(db, "settings", "holidays"), s => { holidays = s.data() || {}; renderPosts(); });
    listen(doc(db, "settings", "summer"), s => { settings = s.data() || {}; fillSummer(); renderPosts(); });
    if (isAdmin) startAdmin();
    else listen(query(collection(db, "announcements"), where("published", "==", true), mine), s => { announcements = list(s); renderNotices(s); });
  }
  document.body.classList.toggle("is-admin", isAdmin);
  $("myAvatar").textContent = me.avatar || "👤";
  $("hello").textContent = isAdmin ? "管理者としてログイン中" : `${me.name}さん・${TARGET[me.classId]}`;
  show("app");
  if (first) { updateDate(); registerPush(false); guide(); }
}

function guide() {
  const k = "guide_" + user.uid;
  if (!store.get(k)) { toast("確認した予定には 👀 を押して知らせよう"); store.set(k, "1"); }
}

/* 日付とカテゴリ */
function updateDate() {
  $("dateNum").textContent = current.getDate();
  $("dateLabel").textContent = `${current.getMonth()+1}月 ${"日月火水木金土"[current.getDay()]}曜日`;
  const diff = Math.round((new Date(ymd(current)) - new Date(ymd(new Date()))) / 86400000);
  $("dateSub").textContent = ({ "-1": "昨日", "0": "今日", "1": "明日" })[diff] || current.getFullYear() + "年";
  $("datePick").value = ymd(current);
  $("today").hidden = ymd(current) === ymd(new Date());
}
function moveTo(d) { current = d; updateDate(); renderPosts(); }
const addDays = n => { const d = new Date(current); d.setDate(d.getDate() + n); return d; };
$("prevDay").onclick = () => moveTo(addDays(-1));
$("nextDay").onclick = () => moveTo(addDays(1));
$("today").onclick = () => moveTo(new Date());
$("datePick").onchange = e => { if (e.target.value) moveTo(new Date(e.target.value + "T12:00:00")); };

const summerActive = () => {
  const t = ymd(new Date());
  return !!(settings.enabled && settings.start && settings.end && t >= settings.start && t <= settings.end);
};
const onDate = p => summerActive() || (ymd(current) >= p.startDate && ymd(current) <= p.endDate);

/* 休みの日：毎週の曜日 ＋ 指定した日 － 例外の登校日 */
let holidays = {}, calDate = new Date();
const weeklyDays = () => holidays.weekly || [];
const isHoliday = d => {
  const key = ymd(d);
  return !(holidays.school || []).includes(key) && ((holidays.dates || []).includes(key) || weeklyDays().includes(d.getDay()));
};
const postsOn = key => posts.filter(p => key >= p.startDate && key <= p.endDate);
const dayAria = (d, count) => `${d.getMonth()+1}月${d.getDate()}日${isHoliday(d) ? "、休み" : ""}${count ? `、投稿${count}件` : ""}`;
// ホームの1週間表示（日曜始まり）
function renderWeek() {
  const start = addDays(-current.getDay());
  $("week").replaceChildren(...Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const key = ymd(d), count = postsOn(key).length;
    return h("button", { type: "button", class: "day" + (count ? " has" : "") + (isHoliday(d) ? " off" : "") + (key === ymd(new Date()) ? " now" : ""),
      "aria-pressed": String(key === ymd(current)), "aria-label": dayAria(d, count), onclick: () => moveTo(d) },
      h("small", { textContent: "日月火水木金土"[i] }), h("b", { textContent: String(d.getDate()) }));
  }));
}

/* 大きいカレンダー画面 */
const CATS = ["予定", "連絡事項", "宿題"];
const catClass = c => "c" + ["予定", "宿題", "連絡事項"].indexOf(c);
function renderBigCalendar() {
  const y = calDate.getFullYear(), m = calDate.getMonth();
  $("calTitle").textContent = `${y}年${m+1}月`;
  $("calGrid").replaceChildren(
    ..."日月火水木金土".split("").map(w => h("span", { class: "weekname", textContent: w })),
    ...Array.from({ length: new Date(y, m, 1).getDay() }, () => h("span")),
    ...Array.from({ length: new Date(y, m + 1, 0).getDate() }, (_, i) => {
      const d = new Date(y, m, i + 1, 12), key = ymd(d), items = postsOn(key);
      return h("button", { type: "button", class: "cell" + (isHoliday(d) ? " off" : "") + (key === ymd(new Date()) ? " now" : ""),
        "aria-pressed": String(key === ymd(calDate)), "aria-label": dayAria(d, items.length),
        onclick: () => { calDate = d; renderBigCalendar(); } },
        h("b", { textContent: String(i + 1) }),
        h("span", { class: "evs" }, items.slice(0, 2).map(p => h("span", { class: "ev " + catClass(p.category), textContent: p.title })),
          items.length > 2 && h("span", { class: "more", textContent: `ほか${items.length - 2}件` })),
        h("span", { class: "dots" }, items.slice(0, 3).map(p => h("i", { class: catClass(p.category) }))));
    }));
  const key = ymd(calDate), items = postsOn(key), off = isHoliday(calDate);
  $("calDay").replaceChildren(
    h("h3", {}, `${calDate.getMonth()+1}月${calDate.getDate()}日（${"日月火水木金土"[calDate.getDay()]}）`, off && h("em", { textContent: "休み" })),
    ...(items.length ? CATS.filter(c => items.some(p => p.category === c)).map(c => h("div", { class: "cal-cat" },
      h("h4", { class: catClass(c), textContent: c }),
      items.filter(p => p.category === c).map(p => h("button", { type: "button", class: "cal-item", onclick: () => { $("calendarDialog").close(); current = new Date(calDate); updateDate(); goToPost(p.id); } },
        h("strong", { textContent: p.title }), h("span", {}, formatted(p.body))))))
      : [h("p", { class: "muted", textContent: "予定・連絡・宿題はありません" })]));
  // 休みの設定は管理者だけ
  $("holidayTools").hidden = !isAdmin;
  $("toggleHoliday").textContent = `${calDate.getMonth()+1}月${calDate.getDate()}日を${off ? "登校日にする" : "休みにする"}`;
  document.querySelectorAll("#weekly input").forEach(i => i.checked = weeklyDays().includes(Number(i.value)));
}
function renderCalendar() { renderWeek(); if ($("calendarDialog").open) renderBigCalendar(); }
function openCalendar() {
  closeMenu(); calDate = new Date(current); $("calendarDialog").showModal(); renderBigCalendar(); $("calendarDialog").scrollTop = 0;
}
function moveMonth(n) {
  const y = calDate.getFullYear(), m = calDate.getMonth() + n;
  calDate = new Date(y, m, Math.min(calDate.getDate(), new Date(y, m + 1, 0).getDate()), 12);
  renderBigCalendar();
}
$("calPrev").onclick = () => moveMonth(-1);
$("calNext").onclick = () => moveMonth(1);
$("calNow").onclick = () => { calDate = new Date(); renderBigCalendar(); };
async function saveHolidays(next, message) {
  await setDoc(doc(db, "settings", "holidays"), { weekly: weeklyDays(), dates: holidays.dates || [], school: holidays.school || [], ...next });
  toast(message);
}
$("toggleHoliday").onclick = e => run(e.currentTarget, null, async () => {
  const key = ymd(calDate), off = isHoliday(calDate), weekly = weeklyDays().includes(calDate.getDay());
  const dates = (holidays.dates || []).filter(x => x !== key), school = (holidays.school || []).filter(x => x !== key);
  if (off && weekly) school.push(key);
  if (!off && !weekly) dates.push(key);
  await saveHolidays({ dates, school }, off ? "登校日にしました" : "休みにしました");
});
$("weekly").addEventListener("change", () => run(null, null, async () => {
  const weekly = [...document.querySelectorAll("#weekly input:checked")].map(i => Number(i.value));
  await saveHolidays({ weekly }, "毎週の休みを保存しました");
}));

// 右側のまとめ：今日の件数、これからの予定、期限が近い宿題
function renderUpcoming() {
  const t = ymd(new Date());
  const today = posts.filter(p => t >= p.startDate && t <= p.endDate);
  const item = (p, date, cls) => h("button", { type: "button", class: "next", onclick: () => goToPost(p.id) },
    h("span", { class: "when " + cls, textContent: `${+date.slice(5,7)}/${+date.slice(8)}` }), h("span", { textContent: p.title }));
  const panel = (title, rows, empty) => h("section", { class: "panel" }, h("h2", { textContent: title }),
    rows.length ? rows : h("p", { class: "muted", textContent: empty }));
  const plans = posts.filter(p => p.category === "予定" && p.startDate > t).sort((a, b) => a.startDate.localeCompare(b.startDate)).slice(0, 4);
  const works = posts.filter(p => p.category === "宿題" && p.endDate >= t).sort((a, b) => a.endDate.localeCompare(b.endDate)).slice(0, 4);
  $("upcoming").replaceChildren(
    h("section", { class: "panel" }, h("h2", { textContent: "今日" }), h("div", { class: "counts" },
      [["予定", "予定"], ["宿題", "宿題"], ["連絡事項", "連絡"]].map(([c, label]) => h("button", { type: "button", onclick: () => { category = c; moveTo(new Date()); } }, h("span", { textContent: label }), h("b", { textContent: String(today.filter(p => p.category === c).length) }))))),
    panel("これからの予定", plans.map(p => item(p, p.startDate, "c0")), "先の予定はありません"),
    panel("期限が近い宿題", works.map(p => item(p, p.endDate, "c1")), "期限が残っている宿題はありません"));
}

// 生徒がまだ「確認した」を押していない確認必須の投稿
const confirms = new Map(); // postId -> { done, off }
function syncTodo() {
  if (isAdmin) return;
  const need = posts.filter(p => p.priority === "confirm" && p.endDate >= ymd(new Date()));
  confirms.forEach((v, id) => { if (!need.some(p => p.id === id)) { v.off(); confirms.delete(id); } });
  need.forEach(p => {
    if (confirms.has(p.id)) return;
    const entry = { done: null, off: () => {} };
    confirms.set(p.id, entry);
    entry.off = onSnapshot(doc(db, "posts", p.id, "reactions", user.uid), s => { entry.done = !!s.data()?.checked; drawTodo(); }, e => console.warn(e));
  });
  drawTodo();
}
function drawTodo() {
  const open = posts.filter(p => confirms.get(p.id)?.done === false);
  $("todo").hidden = !open.length;
  $("todo").replaceChildren(h("h2", { textContent: `確認してください（${open.length}件）` }),
    ...open.map(p => h("button", { type: "button", onclick: () => goToPost(p.id) }, h("span", { textContent: p.title }), h("b", { textContent: "読む" }))));
}

function renderTabs() {
  const today = posts.filter(onDate);
  $("tabs").replaceChildren(...CATEGORIES.map(([id, label]) => h("button", {
    type: "button", class: "tab", "aria-pressed": String(category === id),
    onclick: () => { category = id; renderPosts(); }
  }, h("span", { textContent: label }), h("small", { textContent: String(id === "all" ? today.length : today.filter(p => p.category === id).length) }))), h("button", { type: "button", class: "tab cal-tab", onclick: openCalendar }, h("span", { textContent: "カレンダー" })));
  $("pageTitle").textContent = { all: "すべて", "予定": "予定", "宿題": "宿題", "連絡事項": "連絡事項" }[category];
}

/* 本文の装飾：**太字** [color=#xxx]…[/color] [size=1.2]…[/size] だけを解釈する */
// 改行はCSSに頼らず <br> にする（古いCSSが残っていても改行される）
const lines = text => String(text).split(/\r\n|\r|\n|\u2028/).flatMap((t, i) => i ? [h("br"), t] : [t]);
function formatted(text) {
  const out = [];
  const re = /\*\*([\s\S]+?)\*\*|\[color=(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?)\]([\s\S]*?)\[\/color\]|\[size=(0\.9|1\.1|1\.2)\]([\s\S]*?)\[\/size\]/;
  let rest = String(text || ""), m;
  while ((m = re.exec(rest))) {
    out.push(...lines(rest.slice(0, m.index)));
    if (m[1] !== undefined) out.push(h("strong", {}, formatted(m[1])));
    else {
      const span = h("span", {}, formatted(m[2] ? m[3] : m[5]));
      if (m[2]) span.style.color = m[2]; else span.style.fontSize = m[4] + "em";
      out.push(span);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  out.push(...lines(rest));
  return out;
}

/* 投稿カード。入力中のコメントが消えないよう、カードは使い回す */
function renderPosts() {
  if (!appKey) return;
  renderTabs(); renderCalendar(); renderUpcoming(); syncTodo();
  $("dateBar").hidden = summerActive();
  $("summerBanner").hidden = !summerActive();
  const visible = posts.filter(p => onDate(p) && (category === "all" || p.category === category));
  const ids = new Set(visible.map(p => p.id));
  cards.forEach((c, id) => { if (!ids.has(id)) { c.subs.forEach(f => f()); c.el.remove(); cards.delete(id); } });
  const box = $("posts");
  box.querySelector(".empty")?.remove();
  const place = (parent, el, i) => { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); };
  let n = 0;
  for (const [cat, title] of [["連絡事項", "連絡事項"], ["予定", "予定"], ["宿題", "宿題"]]) {
    let g = groups.get(cat);
    if (!g) {
      const body = h("div", { class: "sheet" }), count = h("small");
      g = { el: h("section", { class: "group" }, h("h2", {}, title, count), body), body, count };
      g.el.dataset.category = cat; groups.set(cat, g);
    }
    const mine = visible.filter(p => p.category === cat);
    if (!mine.length) { g.el.remove(); continue; }
    place(box, g.el, n++);
    g.count.textContent = mine.length + "件";
    mine.forEach((p, i) => { const c = cards.get(p.id) || makeCard(p.id); drawPost(c, p); place(g.body, c.el, i); });
  }
  if (!visible.length) box.append(h("div", { class: "empty" }, ...(postsLoaded
    ? [h("b", { textContent: "この日の投稿はありません" }), h("span", { textContent: "ほかの日付を選ぶと確認できます" })]
    : [h("b", { textContent: "読み込み中…" })])));
}

function makeCard(id) {
  const c = { id, comments: [], reactions: [], subs: [], post: null };
  c.main = h("div", { class: "post-main" });
  c.reactBox = h("div", { class: "row wrap" });
  c.commentList = h("div", { class: "comments" });
  const input = h("textarea", { rows: 1, maxLength: 300, required: true, placeholder: "コメントを入力", "aria-label": "コメント" });
  const send = h("button", { class: "btn primary", textContent: "送信" });
  c.form = h("form", { class: "comment-form", onsubmit: e => {
    e.preventDefault();
    run(send, null, async () => {
      const text = input.value.trim();
      if (!text) return;
      await addDoc(collection(db, "posts", id, "comments"), { uid: user.uid, text, createdAt: serverTimestamp() });
      input.value = ""; await tellAdmin("comment", id);
    });
  } }, input, send);
  c.commentBox = h("div", { class: "stack" }, c.commentList, c.form);
  c.status = h("details", { class: "status", hidden: true });
  c.el = h("article", { class: "post" }, c.main, c.reactBox, c.status, c.commentBox);
  c.el.dataset.id = id;
  const warn = e => console.warn(e);
  c.subs.push(onSnapshot(collection(db, "posts", id, "comments"), s => { c.comments = list(s).sort((a, b) => millis(a.createdAt) - millis(b.createdAt)); drawComments(c); }, warn));
  c.subs.push(onSnapshot(collection(db, "posts", id, "reactions"), s => { c.reactions = list(s); drawReactions(c); }, warn));
  cards.set(id, c);
  return c;
}

function drawPost(c, p) {
  const tag = tags.find(t => t.id === p.tagId);
  const sig = JSON.stringify([p.title, p.body, p.category, p.classTarget, p.startDate, p.endDate, p.imageVersion, p.reactionsEnabled, p.commentsEnabled, tag, summerActive(), p.priority, p.updatedAt && millis(p.updatedAt), ymd(new Date())]);
  c.post = p;
  if (c.sig === sig) return;
  c.sig = sig;
  const md = v => `${+v.slice(5, 7)}月${+v.slice(8)}日`;
  const meta = h("div", { class: "meta" },
    h("span", { textContent: p.classTarget === "両方" ? "全体向け" : TARGET[p.classTarget] }),
    h("span", { textContent: p.startDate === p.endDate ? md(p.startDate) : `${md(p.startDate)}〜${md(p.endDate)}` }));
  if (tag) {
    const chip = h("span", { class: "tag", textContent: tag.name });
    if (/^#[0-9a-fA-F]{6}$/.test(tag.color)) chip.style.setProperty("--tag", tag.color);
    meta.append(chip);
  }
  const t = ymd(new Date()), soon = new Date(); soon.setDate(soon.getDate() + 1);
  const label = (text, cls) => h("span", { class: "label " + cls, textContent: text });
  const labels = [
    p.priority === "important" && label("重要", "important"),
    p.priority === "confirm" && label("確認必須", "confirm"),
    p.category === "宿題" && p.endDate >= t && p.endDate <= ymd(soon) && label("期限間近", "due"),
    p.endDate < t && label("終了", "ended")
  ].filter(Boolean);
  meta.prepend(...labels);
  meta.append(h("span", { class: "posted", textContent: when(p.createdAt) + " 投稿" + (p.updatedAt ? `／${when(p.updatedAt)} 更新` : "") }));
  const head = h("div", { class: "post-head" }, h("h2", { textContent: p.title }));
  c.el.dataset.category = p.category;
  if (isAdmin) head.append(h("div", { class: "tools" },
    h("button", { type: "button", class: "link", textContent: "編集", onclick: () => openPost(c.post) }),
    h("button", { type: "button", class: "link del", textContent: "削除", onclick: e => run(e.currentTarget, null, () => removePost(c.id)) })));
  c.main.replaceChildren(head, meta, h("div", { class: "body" }, formatted(p.body)));
  if (p.priority === "confirm" && !isAdmin) c.main.append(h("p", { class: "muted", textContent: "読んだら「確認した」を押してください。管理者にあなたの名前が表示されます。" }));
  // 画像は夏休み限定モード中は表示しない（元の仕様どおり）
  if (p.imageVersion && !summerActive()) {
    const img = h("img", { class: "photo", alt: "投稿画像", hidden: true });
    c.main.append(img);
    getDoc(doc(db, "images", c.id)).then(s => {
      const data = s.data()?.data;
      if (data?.startsWith("data:image/jpeg;base64,")) { img.src = data; img.hidden = false; }
    }).catch(e => console.warn(e));
  }
  drawReactions(c); drawComments(c);
}

function drawReactions(c) {
  drawStatus(c);
  c.reactBox.hidden = c.post?.reactionsEnabled === false;
  const mine = c.reactions.find(r => r.id === user.uid) || {};
  c.reactBox.replaceChildren(...REACTIONS.map(([type, label]) => h("button", {
    type: "button", class: "reaction", "aria-pressed": String(!!mine[type]),
    onclick: e => run(e.currentTarget, null, async () => {
      const on = !mine[type];
      await setDoc(doc(db, "posts", c.id, "reactions", user.uid), { [type]: on }, { merge: true });
      if (on) await tellAdmin("reaction", c.id);
    })
  }, `${label} ${c.reactions.filter(r => r[type] === true).length}`)));
}

function drawStatus(c) {
  const p = c.post;
  c.status.hidden = !(isAdmin && p?.priority === "confirm");
  if (c.status.hidden) return;
  const target = Object.values(members).filter(m => !suspendedIds.has(m.id) && (p.classTarget === "両方" || m.classId === p.classTarget));
  const done = new Set(c.reactions.filter(r => r.checked === true).map(r => r.id));
  const rest = target.filter(m => !done.has(m.id));
  c.status.replaceChildren(h("summary", { textContent: `確認状況 ${target.length - rest.length}／${target.length}人` }),
    h("p", { textContent: rest.length ? "未確認：" + rest.map(m => `${m.name}（${TARGET[m.classId]}）`).join("、") : target.length ? "全員が確認しました" : "対象の生徒はまだいません" }));
}

const person = uid => uid === ADMIN_UID ? { name: "管理者", avatar: "👑" } : members[uid] || { name: "退会したユーザー", avatar: "👤" };

function drawComments(c) {
  c.commentBox.hidden = c.post?.commentsEnabled === false;
  c.commentList.replaceChildren(...c.comments.map(m => {
    const who = person(m.uid);
    return h("div", { class: "comment" },
      h("span", { class: "avatar small", textContent: who.avatar }),
      h("div", {}, h("strong", { textContent: who.name }), h("span", { class: "muted", textContent: "　" + when(m.createdAt) }), h("p", {}, lines(m.text))),
      isAdmin && h("button", { type: "button", class: "link", textContent: "削除", onclick: e => run(e.currentTarget, null, async () => {
        if (confirm("このコメントを削除しますか？")) { await deleteDoc(doc(db, "posts", c.id, "comments", m.id)); toast("コメントを削除しました"); }
      }) }));
  }));
}

async function removePost(id) {
  if (!confirm("この投稿を削除しますか？コメントとリアクションも消えます。")) return;
  const children = [];
  for (const sub of ["comments", "reactions"]) (await getDocs(collection(db, "posts", id, sub))).forEach(d => children.push(d.ref));
  for (let i = 0; i < children.length; i += 400) {
    const b = writeBatch(db); children.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit();
  }
  const b = writeBatch(db); b.delete(doc(db, "images", id)); b.delete(doc(db, "posts", id)); await b.commit();
  toast("投稿を削除しました");
}

/* ---------- 投稿フォーム（新規・編集） ---------- */
const form = $("postForm"), field = n => form.elements[n];
let editing = null;
function openPost(p) {
  editing = p || null; form.reset(); renderTags(); $("postError").textContent = "";
  $("postDialogTitle").textContent = p ? "投稿を編集" : "新規投稿";
  $("postSubmit").textContent = p ? "保存する" : "投稿する";
  for (const n of ["title","body","category","classTarget","startDate","endDate","tagId"]) if (p) field(n).value = p[n] || "";
  if (!p) field("startDate").value = field("endDate").value = ymd(current);
  field("priority").value = p?.priority || "normal";
  field("reactionsEnabled").checked = p ? p.reactionsEnabled !== false : true;
  field("commentsEnabled").checked = p ? p.commentsEnabled !== false : true;
  $("removeImageRow").hidden = !p?.imageVersion;
  $("postDialog").showModal();
}
$("newPost").onclick = $("fab").onclick = () => { closeMenu(); openPost(); };

// 画像は端末内で縮小してから保存する（位置情報などの付加情報も消える）
async function shrink(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { fail("この画像は読み込めません。JPEGかPNGを選んでください。"); }
  for (const [max, q] of [[1600,.82],[1280,.75],[1024,.68],[800,.6]]) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = h("canvas", { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
    const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(bmp, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL("image/jpeg", q);
    if (url.length < 900000) return url;
  }
  fail("画像が大きすぎます。");
}

form.addEventListener("submit", e => {
  e.preventDefault();
  run($("postSubmit"), "postError", async () => {
    const data = {};
    for (const n of ["title","body","category","classTarget","startDate","endDate"]) data[n] = field(n).value.trim();
    if (!data.title || !data.body) fail("タイトルと本文を入力してください。");
    if (data.endDate < data.startDate) fail("終了日は開始日以降にしてください。");
    data.tagId = field("tagId").value || null;
    data.priority = field("priority").value;
    // 確認必須は「確認した」が押せないと成り立たない
    data.reactionsEnabled = data.priority === "confirm" || field("reactionsEnabled").checked;
    data.commentsEnabled = field("commentsEnabled").checked;
    const file = field("image").files[0];
    const image = file ? await shrink(file) : null;
    const ref = editing ? doc(db, "posts", editing.id) : doc(collection(db, "posts"));
    const b = writeBatch(db);
    if (image) { b.set(doc(db, "images", ref.id), { data: image }); data.imageVersion = Date.now(); }
    else if (editing && field("removeImage").checked) { b.delete(doc(db, "images", ref.id)); data.imageVersion = null; }
    if (editing) b.update(ref, { ...data, updatedAt: serverTimestamp() });
    else b.set(ref, { imageVersion: null, ...data, createdAt: serverTimestamp(), pushed: false });
    await b.commit();
    $("postDialog").close();
    if (!editing) moveTo(new Date(data.startDate + "T12:00:00"));
    toast(editing ? "投稿を更新しました" : "投稿しました");
  });
});

function wrapSelection(make) {
  const t = field("body"), s = t.selectionStart, e = t.selectionEnd;
  if (s === e) return toast("先に本文の文字を選んでください");
  const out = make(t.value.slice(s, e));
  t.setRangeText(out, s, e, "select"); t.focus();
}
$("fmtBold").onclick = () => wrapSelection(x => `**${x}**`);
$("fmtApply").onclick = () => wrapSelection(x => {
  const size = $("fmtSize").value;
  const colored = `[color=${$("fmtColor").value}]${x}[/color]`;
  return size === "1" ? colored : `[size=${size}]${colored}[/size]`;
});

/* ---------- 通知 ---------- */
let notices = [], seenIds = null;
const readKey = () => "read_" + user.uid;
function readState() {
  try { return JSON.parse(store.get(readKey())) || { all: 0, ids: [] }; } catch { return { all: 0, ids: [] }; }
}
function renderNotices() {
  if (isAdmin) {
    const label = { request: "参加申請が届きました", comment: "コメントが届きました", reaction: "リアクションが届きました" };
    notices = inbox.map(n => ({ id: n.id, title: label[n.type] || "通知", text: n.type === "request" ? "ダッシュボードで確認してください" : `${person(n.uid).name}さん`, at: millis(n.createdAt), postId: n.postId, type: n.type, unread: !n.read }));
  } else {
    const r = readState();
    notices = [
      ...posts.map(p => ({ id: "p_" + p.id, title: "新しい投稿", text: p.title, at: millis(p.createdAt), postId: p.id })),
      ...posts.filter(p => p.updatedAt).map(p => ({ id: `u_${p.id}_${millis(p.updatedAt)}`, title: "投稿が更新されました", text: p.title, at: millis(p.updatedAt), postId: p.id })),
      ...announcements.map(a => ({ id: "a_" + a.id, title: "リマインダー：" + a.title, text: a.body || "", at: millis(a.publishAt) }))
    ].map(n => ({ ...n, unread: n.at > r.all && !r.ids.includes(n.id) }));
  }
  notices.sort((a, b) => b.at - a.at); notices = notices.slice(0, 50);
  const unread = notices.filter(n => n.unread).length;
  $("badge").hidden = !unread; $("badge").textContent = unread > 99 ? "99+" : unread;
  $("noticeList").replaceChildren(...(notices.length ? notices.map(n => h("button", { type: "button", class: "notice" + (n.unread ? " unread" : ""), onclick: () => openNotice(n) },
    h("b", { textContent: n.title }), h("span", {}, lines(n.text)), h("span", { class: "muted", textContent: when(n.at) })))
    : [h("p", { class: "muted", textContent: "通知はありません" })]));
  // 開いている間に増えた分だけ知らせる（最初の読み込みでは鳴らさない）
  const fresh = seenIds ? notices.filter(n => n.unread && !seenIds.has(n.id) && n.at > startedAt) : [];
  if (notices.length || seenIds) { seenIds = new Set([...(seenIds || []), ...notices.map(n => n.id)]); }
  if (fresh.length) { toast(fresh[0].title); beep(); }
}
const startedAt = Date.now() - 60000;
async function openNotice(n) {
  $("notices").hidden = true; $("bell").setAttribute("aria-expanded", "false");
  if (n.unread) {
    if (isAdmin) await updateDoc(doc(db, "adminInbox", n.id), { read: true }).catch(e => console.warn(e));
    else { const r = readState(); r.ids = [...r.ids, n.id].slice(-300); store.set(readKey(), JSON.stringify(r)); renderNotices(); }
  }
  if (n.type === "request") $("openDashboard").click();
  else if (n.postId) goToPost(n.postId);
}
function goToPost(id) {
  const p = posts.find(x => x.id === id);
  if (!p) return toast("この投稿は削除されました");
  category = "all";
  if (!onDate(p)) { current = new Date(p.startDate + "T12:00:00"); updateDate(); }
  renderPosts();
  const el = cards.get(id)?.el;
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 2200);
}
$("bell").onclick = () => {
  $("notices").hidden = !$("notices").hidden;
  $("bell").setAttribute("aria-expanded", String(!$("notices").hidden));
};
$("readAll").onclick = e => run(e.currentTarget, null, async () => {
  if (isAdmin) {
    const unread = inbox.filter(n => !n.read);
    for (let i = 0; i < unread.length; i += 400) { const b = writeBatch(db); unread.slice(i, i + 400).forEach(n => b.update(doc(db, "adminInbox", n.id), { read: true })); await b.commit(); }
  } else { store.set(readKey(), JSON.stringify({ all: Date.now(), ids: [] })); renderNotices(); }
  toast("通知をすべて既読にしました");
});
document.addEventListener("click", e => {
  if (!e.target.closest("#notices, #bell")) { $("notices").hidden = true; $("bell").setAttribute("aria-expanded", "false"); }
});

let audio;
function beep() {
  if (store.get("sound") === "off") return;
  try {
    audio ||= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
    g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.12, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + .22);
    o.start(t); o.stop(t + .24);
  } catch (e) { console.warn(e); }
}

/* 閉じていても届く通知 */
let pushError = "";
const pushSupported = () => "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
async function registerPush(ask) {
  if (!pushSupported()) {
    if (ask) toast("この端末では使えません。iPhoneは「ホーム画面に追加」してから開いてください");
    return;
  }
  if (ask && Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission !== "granted") {
    if (ask) toast("ブラウザの設定で通知を許可してください");
    return;
  }
  if (!VAPID_KEY) { if (ask) toast("通知の設定がまだ完了していません（管理者向け：VAPID_KEY）"); return; }
  try {
    const { getMessaging, getToken } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js");
    const reg = await navigator.serviceWorker.register("firebase-messaging-sw.js");
    await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(fb), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    await setDoc(doc(db, "pushTokens", token), { uid: user.uid, updatedAt: serverTimestamp() });
    store.set("pushToken", token); pushError = "";
    if (ask) toast("この端末で通知を受け取ります");
  } catch (e) { console.warn(e); pushError = `${e.code || e.name}: ${e.message}`; if (ask) toast("通知を設定できませんでした"); }
}
function showPushStatus() {
  const perm = "Notification" in window ? Notification.permission : "none";
  const rows = [
    [pushSupported(), "このブラウザは通知に対応"],
    [perm === "granted", "通知が許可されている" + (perm === "denied" ? "（ブロック中：アドレス欄の左のアイコンから許可）" : "")],
    [!!store.get("pushToken") && !pushError, "この端末が登録されている"]
  ];
  $("pushStatus").replaceChildren(...rows.map(([ok, text]) => h("p", { textContent: (ok ? "✅ " : "❌ ") + text })),
    ...(pushError ? [h("p", { class: "error", textContent: "エラー：" + pushError })] : []));
}
$("openPushCheck").onclick = () => { $("notices").hidden = true; showPushStatus(); $("pushDialog").showModal(); };
$("pushRetry").onclick = e => run(e.currentTarget, null, async () => { await registerPush(true); showPushStatus(); });
$("pushLocal").onclick = e => run(e.currentTarget, null, async () => {
  if (!pushSupported() || Notification.permission !== "granted") return toast("先に通知を許可してください");
  await navigator.serviceWorker.register("firebase-messaging-sw.js");
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification("テスト通知", { body: "これが見えれば、端末の設定は大丈夫です", icon: "icon-192.png" });
  toast("テスト通知を出しました");
});
document.querySelectorAll("[data-enable-push]").forEach(b => b.onclick = () => run(b, null, () => registerPush(true)));
navigator.serviceWorker?.addEventListener("message", e => { if (e.data?.postId) goToPost(e.data.postId); });

/* ---------- プロフィールとメニュー ---------- */
let picked = "👤";
function drawAvatars() {
  $("avatarGrid").replaceChildren(...AVATARS.map(a => h("button", { type: "button", role: "radio", "aria-checked": String(a === picked), textContent: a, onclick: () => { picked = a; drawAvatars(); } })));
}
function closeMenu() { $("side").classList.remove("open"); $("scrim").hidden = true; }
$("menuButton").onclick = () => { $("side").classList.add("open"); $("scrim").hidden = false; };
$("scrim").onclick = closeMenu;
document.querySelectorAll("[data-profile]").forEach(b => b.onclick = () => {
  closeMenu();
  $("profileForm").hidden = isAdmin;
  picked = me.avatar; drawAvatars(); $("profileName").value = me.name;
  $("soundToggle").checked = store.get("sound") !== "off";
  $("profileDialog").showModal();
});
$("profileForm").addEventListener("submit", e => {
  e.preventDefault();
  run(e.submitter, "profileError", async () => {
    const name = $("profileName").value.trim();
    if (!name) fail("名前を入力してください。");
    await updateDoc(doc(db, "members", user.uid), { name, avatar: picked });
    store.set("sound", $("soundToggle").checked ? "on" : "off");
    $("profileDialog").close(); toast("プロフィールを更新しました");
  });
});
document.querySelectorAll("[data-open]").forEach(b => b.onclick = () => { closeMenu(); $(b.dataset.open).showModal(); });
document.querySelectorAll("[data-close]").forEach(b => b.onclick = () => b.closest("dialog").close());

/* ---------- 管理者 ---------- */
let requests = [], appeals = [], suspendedIds = new Set(), privates = {};
function startAdmin() {
  listen(collection(db, "requests"), s => { requests = list(s); renderDashboard(); });
  listen(collection(db, "appeals"), s => { appeals = list(s).sort((a, b) => millis(b.createdAt) - millis(a.createdAt)); renderDashboard(); });
  listen(collection(db, "suspended"), s => { suspendedIds = new Set(s.docs.map(d => d.id)); renderDashboard(); cards.forEach(drawStatus); });
  listen(collection(db, "memberPrivate"), s => { privates = Object.fromEntries(list(s).map(m => [m.id, m])); renderDashboard(); });
  listen(doc(db, "config", "invite"), s => { $("inviteCode").value = s.data()?.code || ""; });
  listen(collection(db, "adminInbox"), s => { inbox = list(s); renderNotices(); });
  listen(collection(db, "announcements"), s => { reminders = list(s).sort((a, b) => millis(a.publishAt) - millis(b.publishAt)); renderReminders(); publishDue(); });
  const timer = setInterval(publishDue, 30000);
  appSubs.push(() => clearInterval(timer));
}
// 時刻が来たリマインダーを公開する（サイトを閉じている間は push/Code.gs が行う）
function publishDue() {
  reminders.filter(r => !r.published && millis(r.publishAt) <= Date.now())
    .forEach(r => updateDoc(doc(db, "announcements", r.id), { published: true }).catch(e => console.warn(e)));
}

const button = (label, cls, fn, ask) => h("button", { type: "button", class: "btn small " + cls, textContent: label,
  onclick: e => run(e.currentTarget, "dashError", async () => { if (ask && !confirm(ask)) return; await fn(); }) });
const none = text => [h("p", { class: "muted", textContent: text })];

function renderDashboard() {
  $("requestList").replaceChildren(...(requests.length ? requests.map(r => h("div", { class: "item" },
    h("strong", { textContent: `${r.avatar} ${r.name}（${TARGET[r.classId] || r.classId}）` }),
    h("span", { class: "muted", textContent: r.loginId }),
    h("div", { class: "row" },
      button("承認", "primary", async () => {
        const b = writeBatch(db);
        b.set(doc(db, "members", r.id), { name: r.name, classId: r.classId, avatar: r.avatar, pushed: false });
        b.set(doc(db, "memberPrivate", r.id), { loginId: r.loginId, approvedAt: serverTimestamp() });
        b.delete(doc(db, "requests", r.id));
        await b.commit(); toast("承認しました");
      }),
      button("拒否", "danger", async () => { await deleteDoc(doc(db, "requests", r.id)); toast("拒否しました"); }, `${r.name}さんの申請を拒否しますか？`)))) : none("申請はありません")));

  const people = Object.values(members).sort((a, b) => a.classId.localeCompare(b.classId) || a.name.localeCompare(b.name, "ja"));
  $("memberList").replaceChildren(...(people.length ? people.map(m => {
    const stopped = suspendedIds.has(m.id);
    const sel = h("select", { "aria-label": "クラス", onchange: e => run(e.target, "dashError", async () => { await updateDoc(doc(db, "members", m.id), { classId: e.target.value }); toast("クラスを変更しました"); }) },
      h("option", { value: "7-1", textContent: "7-1組" }), h("option", { value: "7-2", textContent: "7-2組" }));
    sel.value = m.classId;
    return h("div", { class: "item" },
      h("strong", { textContent: `${m.avatar} ${m.name}${stopped ? "　［停止中］" : ""}` }),
      h("span", { class: "muted", textContent: privates[m.id]?.loginId || "" }),
      h("div", { class: "row wrap" }, sel,
        button(stopped ? "再開" : "停止", stopped ? "secondary" : "danger", async () => {
          const ref = doc(db, "suspended", m.id);
          await (stopped ? deleteDoc(ref) : setDoc(ref, { at: serverTimestamp() }));
          toast(stopped ? "再開しました" : "停止しました");
        }, `${m.name}さんを${stopped ? "再開" : "停止"}しますか？`),
        button("削除", "danger", async () => {
          const b = writeBatch(db);
          ["members","memberPrivate","suspended","appeals"].forEach(c => b.delete(doc(db, c, m.id)));
          await b.commit(); toast("削除しました");
        }, `${m.name}さんを削除しますか？（招待コードを知っていると再申請できます）`)));
  }) : none("承認済みユーザーはいません")));

  $("appealList").replaceChildren(...(appeals.length ? appeals.map(a => h("div", { class: "item" },
    h("strong", { textContent: `${members[a.id]?.name || "不明"}（${privates[a.id]?.loginId || a.id}）` }),
    h("span", { class: "muted", textContent: when(a.createdAt) }),
    h("p", {}, lines(a.reason)),
    h("div", {}, button("履歴から削除", "danger", () => deleteDoc(doc(db, "appeals", a.id)), "この申し立てを削除しますか？")))) : none("異議申し立てはありません")));
}

function renderTags() {
  const sel = field("tagId"), keep = sel.value;
  sel.replaceChildren(h("option", { value: "", textContent: "タグなし" }), ...tags.map(t => h("option", { value: t.id, textContent: t.name })));
  sel.value = tags.some(t => t.id === keep) ? keep : "";
  if (!isAdmin) return;
  $("tagList").replaceChildren(...tags.map(t => {
    const name = h("input", { value: t.name, maxLength: 20, "aria-label": "タグ名" });
    const color = h("input", { type: "color", value: t.color, "aria-label": "色" });
    return h("div", { class: "item" }, h("div", { class: "row wrap" }, name, color,
      button("保存", "secondary", async () => { if (!name.value.trim()) fail("タグ名を入力してください。"); await updateDoc(doc(db, "tags", t.id), { name: name.value.trim(), color: color.value }); toast("タグを保存しました"); }),
      button("削除", "danger", () => deleteDoc(doc(db, "tags", t.id)), "このタグを削除しますか？")));
  }));
}

function renderReminders() {
  $("reminderList").replaceChildren(...(reminders.length ? reminders.map(r => h("div", { class: "item" },
    h("strong", { textContent: r.title }), r.body && h("p", { class: "muted" }, lines(r.body)),
    h("span", { class: "muted", textContent: `${when(r.publishAt)}・${TARGET[r.classTarget]}・${r.published ? "通知済み" : "予約中"}` }),
    h("div", {}, button("削除", "danger", () => deleteDoc(doc(db, "announcements", r.id)), "このリマインダーを削除しますか？")))) : none("リマインダーはありません")));
}

function fillSummer() {
  $("summerOn").checked = !!settings.enabled;
  $("summerStart").value = settings.start || ""; $("summerEnd").value = settings.end || "";
  $("summerStatus").textContent = !settings.enabled ? "現在はオフです" : summerActive() ? "現在は有効です" : "設定済みです（期間外）";
}

$("openDashboard").onclick = () => { closeMenu(); $("dashError").textContent = ""; fillSummer(); $("dashboard").showModal(); $("dashboard").scrollTop = 0; };
$("openReminder").onclick = () => { $("openDashboard").click(); $("reminderHeading").scrollIntoView(); };
$("inviteRandom").onclick = () => {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  $("inviteCode").value = Array.from(crypto.getRandomValues(new Uint8Array(10)), n => abc[n % abc.length]).join("");
};
const adminForm = (id, fn) => $(id).addEventListener("submit", e => { e.preventDefault(); run(e.submitter, "dashError", () => fn(e.target)); });
adminForm("inviteForm", async () => {
  const code = $("inviteCode").value.trim().toUpperCase();
  if (code.length < 8) fail("招待コードは8文字以上にしてください。");
  await setDoc(doc(db, "config", "invite"), { code }); toast("招待コードを保存しました");
});
adminForm("tagForm", async f => {
  const name = $("tagName").value.trim();
  if (!name) fail("タグ名を入力してください。");
  await addDoc(collection(db, "tags"), { name, color: $("tagColor").value }); f.reset(); toast("タグを追加しました");
});
adminForm("reminderForm", async f => {
  const title = $("remTitle").value.trim(), publishAt = new Date($("remAt").value);
  if (!title || Number.isNaN(publishAt.getTime())) fail("タイトルと通知日時を入力してください。");
  if (publishAt.getTime() < Date.now()) fail("通知日時は今より後にしてください。");
  await addDoc(collection(db, "announcements"), { title, body: $("remBody").value.trim(), classTarget: $("remTarget").value, publishAt, published: false, pushed: false });
  f.reset(); toast("リマインダーを予約しました");
});
adminForm("summerForm", async () => {
  const enabled = $("summerOn").checked, start = $("summerStart").value, end = $("summerEnd").value;
  if (enabled && (!start || !end)) fail("開始日と終了日を入力してください。");
  if (enabled && end < start) fail("終了日は開始日以降にしてください。");
  await setDoc(doc(db, "settings", "summer"), { enabled, start, end }); toast("設定を保存しました");
});
