"use strict";

/**
 * 明御 USM 网关适配的单元测试：路径解析、前缀翻译、通道包装、
 * 以及"先切 UTF-8"的探测逻辑。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  USM_CHARSET_TOGGLE_RE,
  switchUsmGatewayToUtf8,
  parseUsmAssetEntry,
  getUsmGatewayState,
  ensureUsmGatewayState,
  installUsmSftpChannel,
  toUsmVisiblePath,
} = require("./usmGateway.cjs");

const ENTRY = "/10.164.12.119:22_ssh_root@视频监控服务";

test("parseUsmAssetEntry splits asset entry and inner path", () => {
  assert.deepEqual(parseUsmAssetEntry(ENTRY), { entry: ENTRY, rest: "" });
  assert.deepEqual(parseUsmAssetEntry(`${ENTRY}/tmp/x.log`), {
    entry: ENTRY,
    rest: "/tmp/x.log",
  });
  assert.deepEqual(parseUsmAssetEntry(`${ENTRY}/`), { entry: ENTRY, rest: "" });
  assert.equal(parseUsmAssetEntry("/"), null);
  assert.equal(parseUsmAssetEntry("/etc/passwd"), null);
  assert.equal(parseUsmAssetEntry("relative/path"), null);
  assert.equal(parseUsmAssetEntry(undefined), null);
});

test("charset toggle names are recognised", () => {
  assert.ok(USM_CHARSET_TOGGLE_RE.test("!now_gb18030,next_UTF-8"));
  assert.ok(USM_CHARSET_TOGGLE_RE.test("!now_UTF-8,next_gb18030"));
  assert.ok(!USM_CHARSET_TOGGLE_RE.test("normal-dir"));
  assert.ok(!USM_CHARSET_TOGGLE_RE.test("!now_big5,next_UTF-8"));
});

const makeConnection = () => ({});

const makeClientWithChannel = (channel) => {
  const conn = makeConnection();
  const client = { client: conn, sftp: channel };
  return client;
};

test("bound paths are translated, unrelated paths are not", () => {
  const conn = makeConnection();
  const state = ensureUsmGatewayState({ client: conn });
  assert.equal(state.boundAsset, null);

  const client = { client: conn, sftp: {} };
  assert.equal(installUsmSftpChannel(client, client.sftp), client.sftp);

  // 未绑定：通道原样返回
  assert.equal(getUsmGatewayState(client), state);

  state.boundAsset = ENTRY;
  const seen = [];
  const channel = {
    readdir: (p, cb) => { seen.push(["readdir", p]); cb(null, []); },
    stat: (p, cb) => { seen.push(["stat", p]); cb(null, {}); },
    rename: (from, to, cb) => { seen.push(["rename", from, to]); cb(null); },
    symlink: (target, linkPath, cb) => { seen.push(["symlink", target, linkPath]); cb(null); },
    fastPut: (local, remote, cb) => { seen.push(["fastPut", local, remote]); cb(null); },
  };
  const proxy = installUsmSftpChannel({ client: conn, sftp: channel }, channel);

  proxy.readdir(`${ENTRY}/tmp`, () => {});
  proxy.readdir("/", () => {});
  proxy.stat(`${ENTRY}/etc/hostname`, () => {});
  proxy.rename(`${ENTRY}/a`, `${ENTRY}/b`, () => {});
  proxy.symlink("a", `${ENTRY}/b`, () => {});
  proxy.fastPut("C:/tmp/local", `${ENTRY}/tmp/remote`, () => {});

  assert.deepEqual(seen, [
    ["readdir", "/tmp"],
    ["readdir", "/"],
    ["stat", "/etc/hostname"],
    ["rename", "/a", "/b"],
    ["symlink", "a", "/b"],
    ["fastPut", "C:/tmp/local", "/tmp/remote"],
  ]);
});

test("channel wrapping is cached per raw channel", () => {
  const conn = makeConnection();
  const client = { client: conn, sftp: {} };
  const store = ensureUsmGatewayState(client);
  store.boundAsset = ENTRY;

  const raw = { readdir: () => {} };
  const client2 = { client: conn, sftp: raw };
  const first = installUsmSftpChannel(client2, raw);
  const second = installUsmSftpChannel(client2, first);
  assert.equal(second, first);
});

test("realpath results are shown with the asset prefix", () => {
  const conn = makeConnection();
  const client = { client: conn, sftp: {} };
  assert.equal(toUsmVisiblePath(client, "/etc/hostname"), "/etc/hostname");

  ensureUsmGatewayState(client).boundAsset = ENTRY;
  assert.equal(toUsmVisiblePath(client, "/"), ENTRY);
  assert.equal(toUsmVisiblePath(client, "/etc/hostname"), `${ENTRY}/etc/hostname`);
  // 已经是界面路径时不再叠加前缀
  assert.equal(toUsmVisiblePath(client, ENTRY), ENTRY);
  assert.equal(toUsmVisiblePath(client, `${ENTRY}/etc`), `${ENTRY}/etc`);
});

const fakeChannel = ({ entriesOnRoot = [], afterSwitch = null } = {}) => {
  const calls = [];
  let root = entriesOnRoot;
  const sftp = {
    readdir: (p, cb) => {
      calls.push(["readdir", p]);
      if (afterSwitch && p === "/" && calls.some((c) => c[0] === "realpath")) {
        root = afterSwitch;
      }
      cb(null, root.map((name) => ({ filename: name })));
    },
    realpath: (p, cb) => {
      calls.push(["realpath", p]);
      // 网关切换字符集时回状态码，但副作用已生效
      cb(Object.assign(new Error("charactor is changed please refresh director"), { code: 4 }));
    },
  };
  return { sftp, calls };
};

test("switchUsmGatewayToUtf8 dives through the toggle pseudo-directory", async () => {
  const { sftp, calls } = fakeChannel({
    entriesOnRoot: ["!now_gb18030,next_UTF-8", ENTRY],
    afterSwitch: ["!now_UTF-8,next_gb18030", ENTRY],
  });
  assert.equal(await switchUsmGatewayToUtf8(sftp, "/"), true);
  assert.deepEqual(calls[0], ["readdir", "/"]);
  assert.deepEqual(calls[1], ["realpath", "!now_gb18030,next_UTF-8"]);
  // 同一通道第二次调用直接复用记忆结果
  calls.length = 0;
  assert.equal(await switchUsmGatewayToUtf8(sftp, "/"), true);
  assert.deepEqual(calls, []);
});

test("switchUsmGatewayToUtf8 leaves ordinary servers alone", async () => {
  const { sftp } = fakeChannel({ entriesOnRoot: ["etc", "var"] });
  assert.equal(await switchUsmGatewayToUtf8(sftp, "/"), false);

  const nested = fakeChannel({ entriesOnRoot: ["etc"] });
  assert.equal(await switchUsmGatewayToUtf8(nested.sftp, "/var/log"), false);
  assert.deepEqual(nested.calls, []);
});

test("switchUsmGatewayToUtf8 keeps GB18030 mode when the switch did not apply", async () => {
  // 切换后伪目录名没有变化 -> 认为没生效
  const { sftp } = fakeChannel({
    entriesOnRoot: ["!now_gb18030,next_UTF-8"],
    afterSwitch: ["!now_gb18030,next_UTF-8"],
  });
  assert.equal(await switchUsmGatewayToUtf8(sftp, "/"), false);
});

test("an already-UTF-8 gateway is detected without switching", async () => {
  const { sftp, calls } = fakeChannel({
    entriesOnRoot: ["!now_UTF-8,next_gb18030", ENTRY],
  });
  assert.equal(await switchUsmGatewayToUtf8(sftp, "/"), true);
  assert.deepEqual(calls, [["readdir", "/"]]);
});
