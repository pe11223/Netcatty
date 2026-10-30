/**
 * 明御(安恒) USM 堡垒机网关适配
 *
 * 这类网关用一条 OpenSSH SFTP 连接代管多台资产：
 *
 *   /                                   <- 虚拟根目录，子目录是资产入口
 *   /10.164.12.119:22_ssh_root@视频监控服务
 *   /10.164.12.138:22_ssh_root@网络代理服务器
 *
 * 两条与常规 SFTP 服务器不同的语义必须在这里处理掉：
 *
 * 1. 入口名是 GB18030 字节。用 GB18030 路径 opendir 资产入口会让网关直接断链
 *    （客户端看到的是 EOF / "Unexpected end of SFTP packet"），所以要先对根目录
 *    里的字符集切换伪目录做一次 REALPATH，把这条连接切到 UTF-8。
 * 2. REALPATH 进入某个入口后，网关就把这条 SSH 连接固定绑定在该资产上：之后
 *    所有绝对路径都按"资产内的路径"解释，换资产只能新开 SSH 连接。绑定与 SFTP
 *    通道无关，同一连接上新开的通道同样在该资产里。
 *
 * 因此界面里继续用 "/<资产入口>/…" 这样的路径，而本模块在通道层做路径翻译：
 * 绑定资产之后，凡是以该入口开头的路径都先去掉入口前缀再发给网关。
 * 绑定状态挂在 ssh2 Client 上，所以同一连接上派生的 session-backed SFTP
 * 客户端（传输通道）共享同一份绑定关系。
 */

// 网关根目录下的字符集切换伪目录："now_" 后面是当前字符集，进去一次切到 next_。
const USM_CHARSET_TOGGLE_RE = /^!now_(?:gb18030|UTF-8),next_(?:gb18030|UTF-8)$/i;
const USM_SWITCH_TO_UTF8_RE = /^!now_gb18030,next_UTF-8$/i;
// 已经切到 UTF-8 的通道不再重复探测（通道对象随连接变化，故用 WeakSet）
const usmUtf8Channels = new WeakSet();

// "/<入口>[/子路径]"；入口形如 10.164.12.119:22_ssh_root@视频监控服务
const USM_ASSET_ENTRY_RE = /^(\/[^/]+:\d+_[^/@]*@[^/]+)(\/.*)?$/;

// 第一个参数是远端路径的通道方法
const USM_PATH_ARG_METHODS = new Set([
  "readdir", "stat", "lstat", "realpath", "open", "opendir", "unlink", "rmdir",
  "mkdir", "chmod", "chown", "utimes", "setstat", "readlink", "readFile",
  "writeFile", "appendFile", "exists", "createReadStream", "createWriteStream",
]);

const readdirPromise = (sftp, target) =>
  new Promise((resolve, reject) => {
    sftp.readdir(target, (err, items) => (err ? reject(err) : resolve(items || [])));
  });

const realpathPromise = (sftp, target) =>
  new Promise((resolve, reject) => {
    sftp.realpath(target, (err, name) => (err ? reject(err) : resolve(name)));
  });

/**
 * 把网关切到 UTF-8。对伪目录做一次 REALPATH 时网关会回失败状态
 * ("charactor is changed please refresh director")，但副作用已经生效。
 * 返回 true 表示这条通道现在收发 UTF-8。
 */
async function switchUsmGatewayToUtf8(sftp, basePath) {
  if (!sftp) return false;
  if (usmUtf8Channels.has(sftp)) return true;
  const normalized = String(basePath ?? "/").replace(/\/+$/, "") || "/";
  if (normalized !== "/" && normalized !== ".") return false;

  let entries;
  try {
    entries = await readdirPromise(sftp, normalized);
  } catch {
    return false;
  }
  const toggle = entries.find((entry) => USM_SWITCH_TO_UTF8_RE.test(entry?.filename || ""));
  if (!toggle) {
    // 伪目录还在，但已经是 UTF-8 了（或是别的网关实现）
    const alreadyUtf8 = entries.some((entry) =>
      USM_CHARSET_TOGGLE_RE.test(entry?.filename || ""),
    );
    if (alreadyUtf8) usmUtf8Channels.add(sftp);
    return alreadyUtf8;
  }

  try {
    await realpathPromise(sftp, toggle.filename);
  } catch {
    // 预期内的失败：网关用这个状态码表示"字符集已切换，请刷新目录"
  }
  try {
    const after = await readdirPromise(sftp, normalized);
    const stillGb = after.some((entry) =>
      USM_SWITCH_TO_UTF8_RE.test(entry?.filename || ""),
    );
    if (stillGb) return false; // 切换没生效，保持原有 GB18030 逻辑
  } catch {
    // 刷新失败不致命：切换本身已发送
  }
  usmUtf8Channels.add(sftp);
  return true;
}

const getUsmConnectionOwner = (client) => client?.client || client || null;

const getUsmGatewayState = (client) => getUsmConnectionOwner(client)?.__netcattyUsmGateway || null;

const ensureUsmGatewayState = (client) => {
  const owner = getUsmConnectionOwner(client);
  if (!owner || typeof owner !== "object") return null;
  if (!owner.__netcattyUsmGateway) {
    owner.__netcattyUsmGateway = { boundAsset: null };
  }
  return owner.__netcattyUsmGateway;
};

/** 把 "/<资产入口>[/子路径]" 拆成入口和入口内路径；不是这种形状时返回 null。 */
const parseUsmAssetEntry = (input) => {
  if (typeof input !== "string" || !input.startsWith("/")) return null;
  const normalized = input.length > 1 ? input.replace(/\/+$/, "") : "/";
  const match = USM_ASSET_ENTRY_RE.exec(normalized);
  if (!match) return null;
  return { entry: match[1], rest: match[2] || "" };
};

/** 界面路径 -> 网关路径：绑定资产后剥掉入口前缀。 */
const translateUsmPath = (owner, value) => {
  const bound = owner?.__netcattyUsmGateway?.boundAsset;
  if (!bound || typeof value !== "string") return value;
  if (value === bound) return "/";
  if (value.startsWith(`${bound}/`)) return value.slice(bound.length) || "/";
  return value;
};

/** 网关路径 -> 界面路径：realpath 之类返回的资产内路径补回入口前缀。 */
const toUsmVisiblePath = (client, value) => {
  const bound = getUsmGatewayState(client)?.boundAsset;
  if (!bound || typeof value !== "string" || !value.startsWith("/")) return value;
  if (value === bound || value.startsWith(`${bound}/`)) return value;
  if (value === "/") return bound;
  return `${bound}${value}`;
};

const usmChannelProxies = new WeakMap(); // 原通道 -> 翻译通道
const usmChannelProxySet = new WeakSet(); // 已经包过的通道，避免套两层

/** 绑定资产后包一层通道，把所有远端路径翻译成资产内路径。 */
const wrapUsmChannel = (owner, sftp) => {
  if (!sftp || !owner || !owner.__netcattyUsmGateway?.boundAsset) return sftp;
  if (usmChannelProxySet.has(sftp)) return sftp;
  const cached = usmChannelProxies.get(sftp);
  if (cached) return cached;
  const proxy = new Proxy(sftp, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      if (prop === "rename") {
        return (from, to, ...rest) => target.rename(
          translateUsmPath(owner, from),
          translateUsmPath(owner, to),
          ...rest,
        );
      }
      if (prop === "fastPut") {
        // fastPut(localPath, remotePath, ...)：远端路径是第二个参数
        return (localPath, remotePath, ...rest) => target.fastPut(
          localPath,
          translateUsmPath(owner, remotePath),
          ...rest,
        );
      }
      if (prop === "symlink" || prop === "link") {
        return (existing, next, ...rest) => target[prop](
          existing,
          translateUsmPath(owner, next),
          ...rest,
        );
      }
      if (USM_PATH_ARG_METHODS.has(prop)) {
        return (first, ...rest) => target[prop](
          translateUsmPath(owner, first),
          ...rest,
        );
      }
      return value.bind(target);
    },
  });
  usmChannelProxies.set(sftp, proxy);
  usmChannelProxySet.add(proxy);
  return proxy;
};

/** 网关会话里所有通道都换成翻译通道；非 USM 会话原样返回。 */
const installUsmSftpChannel = (client, sftp) => {
  if (!client || !sftp) return sftp;
  const owner = getUsmConnectionOwner(client);
  if (!owner?.__netcattyUsmGateway?.boundAsset) return sftp;
  const wrapped = wrapUsmChannel(owner, sftp);
  if (client.sftp !== wrapped) client.sftp = wrapped;
  return wrapped;
};

module.exports = {
  USM_CHARSET_TOGGLE_RE,
  switchUsmGatewayToUtf8,
  parseUsmAssetEntry,
  getUsmGatewayState,
  ensureUsmGatewayState,
  installUsmSftpChannel,
  translateUsmPath,
  toUsmVisiblePath,
};
