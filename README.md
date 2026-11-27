# LinkForge Cache

一个从零实现的本地持久化产物缓存，面向同一台机器上并行运行的链接器/构建进程。运行时零第三方依赖，仅使用 Node.js 内置模块；开发依赖只有 TypeScript 和 Node 类型。

核心能力：

- 按完整键存入、还原、撤下产物，并查询真实占用。
- 基于已有基准键和若干字节覆盖区间派生等长产物。
- 派生产物先核对整件 SHA-256，通过后才原子发布。
- 还原时再次核对整件 SHA-256；校验失败只返回 `DIGEST_MISMATCH`，不生成目标文件。
- 内容寻址 Blob + 区间 Extent，未修改字节和相同副本只留存一份。
- 基准键撤下后新请求立即 `NOT_FOUND`；已发布派生条目仍可还原。
- 读者选定版本后获得硬链接快照；即使 `SIGSTOP`、撤下、GC，恢复后仍可还原选中版本。
- 空间不足时按“最近一次成功还原时间；从未还原则用发布时间”从冷到热淘汰，只淘汰到满足配额。
- 腾不足时拒绝写入；预检查阶段不删任何已有键。
- 占用只统计 `blobs/`、`tmp/`、读者 `data/` 中的产物数据，按 `dev:inode` 去重；元数据、锁和调用方输出文件不计。
- `SIGKILL` 后的遗留写入、半成品和死读者租约在下次 `Cache.open()` 时清理；若持久状态超额，会先冷键淘汰到配额内。

## 安装与一条命令测试

要求 Node.js 20.11+，多进程和崩溃恢复测试在 Linux 上运行（使用 `/proc` 判断 PID 是否被复用，并优先使用系统 `flock`）。

```bash
npm install
npm test
```

`npm test` 会先执行 TypeScript 构建，再运行 `node:test`。完整套件通常约 15–25 秒，远低于 80 秒；结果使用 spec reporter 输出。

测试使用运行时生成的高熵随机数据，覆盖：

- 8 MiB 基线 + 12 代 64 KiB 覆盖派生，总占用精确为 `8 MiB + 12 × 64 KiB = 9,175,040` 字节。
- 只留末代后加入 768 KiB 高熵产物，占用为 `9,240,576` 字节，仍在 9 MiB 内。
- 多进程派生/读写竞争和小配额淘汰竞争。
- `SIGSTOP` 读者期间由其他进程撤下并 GC。
- `SIGKILL -9` 写入进程和读者进程。
- 损坏 Blob 后还原失败且不交付输出文件。
- CLI 与 HTTP 接口。

## 本地启动 HTTP 接口

```bash
npm run build
npm start -- --dir .linkforge-cache --quota 9m --host 127.0.0.1 --port 4789
```

接口示例：

```bash
# 存入完整产物
curl -X PUT \
  --data-binary @artifact.bin \
  -H 'X-Expected-Digest: sha256:'$(sha256sum artifact.bin | cut -d' ' -f1) \
  'http://127.0.0.1:4789/v1/keys?key=base'

# 还原；响应头 x-digest 是整件摘要，服务端已在校验通过后才返回
curl -o restored.bin 'http://127.0.0.1:4789/v1/keys?key=base'

# 查询占用
curl 'http://127.0.0.1:4789/v1/stats'

# 撤下
curl -X DELETE 'http://127.0.0.1:4789/v1/keys?key=base'

# 派生：ranges 中的 dataBase64 是要覆盖到 offset 的新字节
curl -X POST 'http://127.0.0.1:4789/v1/derive' \
  -H 'content-type: application/json' \
  -d '{
    "newKey": "generation-1",
    "baseKey": "base",
    "expectedDigest": "整件 SHA-256 hex",
    "ranges": [
      { "offset": 1000003, "dataBase64": "<64 KiB base64>" }
    ]
  }'
```

## CLI 用法

```bash
CACHE=.linkforge-cache

# 存入
node dist/cli.js put base ./artifact.bin --dir "$CACHE" --quota 9m

# 还原到调用方指定路径
node dist/cli.js get base ./restored.bin --dir "$CACHE"

# 派生。ranges.json 支持 dataBase64、UTF-8 data，或相对于 ranges.json 的 path
cat > ranges.json <<'JSON'
[
  { "offset": 1000003, "path": "./patch-0.bin" },
  { "offset": 2000000, "dataBase64": "..." }
]
JSON

node dist/cli.js derive gen-1 base <expected-sha256-hex> ranges.json --dir "$CACHE"

# 查询占用 / 列出键 / 手动 GC / 撤下
node dist/cli.js stat --dir "$CACHE"
node dist/cli.js keys --dir "$CACHE"
node dist/cli.js gc --dir "$CACHE"
node dist/cli.js rm base --dir "$CACHE"
```

也可以通过 `npm run cli -- stat --dir .linkforge-cache` 运行。

## 程序化接口

```ts
import crypto from 'node:crypto';
import { Cache } from './dist/index.js';

const cache = await Cache.open({
  dir: '.linkforge-cache',
  quotaBytes: 9 * 1024 * 1024, // 也支持 '9m' / '9MiB'
});

const base = crypto.randomBytes(8 * 1024 * 1024);
await cache.put('base', base);

const offset = 1_000_003;
const patch = crypto.randomBytes(64 * 1024);
const expected = Buffer.from(base);
patch.copy(expected, offset);
const expectedDigest = crypto.createHash('sha256').update(expected).digest('hex');

await cache.derive('gen-1', {
  baseKey: 'base',
  ranges: [{ offset, data: patch }],
  expectedDigest, // 必填；可带 sha256: 前缀
});

// 一次性还原：内部自动创建并释放读者快照
await cache.restore('gen-1', './gen-1.bin');
const verifiedBuffer = await cache.read('gen-1');

// 长生命周期/可暂停读者：openRead 成功即已硬链接全部所需 Blob
await using lease = await cache.openRead('gen-1');
// 此时可以 SIGSTOP 当前进程；其他进程撤下/GC 后仍可还原。
await lease.restoreTo('./gen-1-slow.bin');
await lease.release();

const stats = await cache.stats();
console.log(stats.occupiedBytes, stats.quotaBytes, stats.keys);

await cache.remove('base');
await cache.close();
```

### 主要方法

- `Cache.open({ dir, quotaBytes?, lockTimeoutMs?, recover? })`
- `put(key, Buffer | Uint8Array | { path }, { expectedDigest?, overwrite? })`
- `derive(newKey, { baseKey, ranges: [{ offset, data }], expectedDigest, overwrite? })`
- `restore(key, outputPath)`：校验通过后原子 rename 到输出路径。
- `read(key)`：校验通过后返回 `Buffer`。
- `openRead(key)`：返回不可变读者租约 `ReadLease`。
- `remove(key)` / `delete(key)` / `withdraw(key)`
- `occupancy()`：直接返回实际占用字节数。
- `stats()`：返回 `occupiedBytes`、`quotaBytes`、`availableBytes` 和冷热排序的键信息。
- `gc()`：清理死读者、死写入临时文件和无键引用的 Blob。

错误码包括：`NOT_FOUND`、`KEY_EXISTS`、`DIGEST_MISMATCH`、`QUOTA_EXCEEDED`、`INVALID_ARGUMENT`、`LOCK_TIMEOUT`、`CORRUPT_CACHE`。

## 磁盘结构与一致性模型

```text
<dir>/
  format.json
  cache.flock                 # Linux flock 互斥锁文件，非产物数据
  keys/<sha256(key)>.json     # 已确认键清单、时间、Extent、摘要
  blobs/<xx>/<sha256>.bin     # 内容寻址产物数据
  tmp/w-<pid>-<starttime>-<token>.tmp
  readers/<lease-id>/
    lease.json                # 元数据，不计入占用
    data/<sha256>.bin         # 到 Blob 的硬链接；撤下/GC 后保住选中版本
  locks/                      # 无 flock 命令时的 PID 锁回退实现
```

派生清单不保存整件副本，而是保存连续 Extent：

- 未修改区间继续指向基准 Blob 的对应切片。
- 新覆盖区间指向新的内容寻址区间 Blob。
- 从派生键继续派生时会直接把父清单“压平”到最终底层 Blob 引用，因此同一整段被再次完整覆盖后，旧补丁不会成为末代恢复路径上的必需数据。

发布使用同目录临时文件、`fsync` 和原子 `rename`。键文件名是键名的 SHA-256，避免 `/`、`..`、Unicode 等键名造成路径问题。

## 多进程和崩溃恢复

- Linux 上临界区使用 `flock(1)` 辅助进程持有 OS 锁；Node 进程被 `SIGKILL` 后，辅助进程的 stdin 关闭并退出，OS 自动释放锁。
- 没有 `flock` 命令时回退到“先写完整 Owner JSON，再 hard link 到 lock 文件”的 PID/`/proc` starttime 锁。
- 读者选定版本时在全局锁内创建所有 Blob 的硬链接和完整 `lease.json`，随后立即释放全局锁。
- GC 可以删除 `blobs/` 中已无键引用的目录项；读者租约中的硬链接仍保留 inode，所以暂停读者能继续读取。
- 占用扫描按 `dev:ino` 去重，CAS Blob 和读者硬链接不会重复计数；CAS 目录项删除后，只要读者硬链接存在，仍按一个 inode 计数。
- 下次 `Cache.open()` 会：
  1. 清理键 JSON 的半成品临时文件；
  2. 删除 Owner PID 已死的 `tmp/` 写入；
  3. 删除 Owner PID 已死的读者租约；
  4. GC 无引用 Blob；
  5. 如持久投影仍超过配额，从最冷键开始淘汰到配额内。

## 配额场景为什么能放下

9 MiB = `9,437,184` 字节。

12 代都修改同一个 64 KiB 高熵区间时：

```text
8 MiB 基线 Blob + 12 × 64 KiB 新区间 Blob
= 9,175,040 字节 < 9,437,184 字节
```

删除基线和前 11 代、只留末代后，无引用区间被 GC：

```text
8 MiB + 64 KiB = 8,454,144 字节
8,454,144 + 768 KiB = 9,240,576 字节 < 9,437,184 字节
```

元数据不进入 `occupiedBytes`。高熵数据不可压缩，测试也不依赖压缩或随机内容去重。
