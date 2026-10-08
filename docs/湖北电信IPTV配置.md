# IPTV 路由器配置手册（iStoreOS / 192.168.1.1）

> 本文档记录 IPTV 全链路的完整配置（现网最终生效值）、换路由器迁移步骤、验证与排障命令。
> SSH：`ssh root@192.168.1.1`（密码见密码管理，本文不存储）
> 本地离线备份：`docs/router_backup_20260906/`（fcc.m3u、rtp2httpd 二进制、network/firewall/dhcp/omcproxy/udpxy/rtp2httpd 配置、sysctl.conf、rc.local）
> ⚠️ 换路由器注意：本文 wan1=IPTV 拨号口绑定物理口 eth1，新路由器物理口对应关系可能不同，以 LuCI「网络→接口」里各接口实际绑定的 device 为准。

## 一、拓扑总览

```
湖北电信 IPTV 城域网
        │ (wan1, PPPoE 专用拨号)
        ▼
┌─────────────────────────────────────────────┐
│ iStoreOS 25.12 (x86_64)                     │
│                                             │
│  pppoe-wan1  10.x.x.x  [IGMPv2 强制]        │
│     │                                       │
│     ├── omcproxy      组播代理(IPTV→lan)     │
│     └── rtp2httpd :588 组播→HTTP 转 TS 流    │
│                                             │
│  br-lan (eth2+eth3) 192.168.1.1/24          │
│     [igmp_snooping=1 + querier=1]           │
│     ├── 机顶盒（直收组播）                     │
│     └── 手机/TV APP（拉 http://192.168.1.1:588/rtp/…）│
└─────────────────────────────────────────────┘
公网侧（wan 口 pppoe-wan，IPv4 拨号，metric=3）：
  888 → 192.168.1.1:80   下载频道表
  588 → 192.168.1.1:588  外网直接拉流
```

**各组件分工**：

| 组件 | 职责 | 配置来源 |
| --- | --- | --- |
| wan / wan1 双 PPPoE | wan=公网上网（metric=3 独占默认路由）；wan1=IPTV 专口（metric=20，无默认路由） | `/etc/config/network` |
| iptv-assistant 插件 | IGMPv2 强制、组播桥优化（snooping/querier）、FCC 快速换台路由，LuCI「网络→IPTV 网络助手」可视化管理 | `/etc/config/iptv_assistant` |
| omcproxy | 把 IPTV 口的组播按 IGMP 订阅代理进 br-lan（要求防火墙 lan 区含 wan1） | `/etc/config/omcproxy` |
| rtp2httpd | 把 UDP 组播转成 HTTP TS 流，并实现 FCC 快速换台 | `/etc/config/rtp2httpd`（LuCI「网络→rtp2httpd」可视化编辑） |
| dnsmasq→AdGuardHome | 全网 DNS：终端→dnsmasq:53→AdGuardHome:5253 过滤→上游 | `/etc/config/dhcp` + AdGuardHome 自身配置 |
| udpxy | 同类工具，**已禁用不用** | `/etc/config/udpxy` disabled=1，自启已关 |

## 二、iStoreOS 系统参数

| 项 | 值 |
| --- | --- |
| 系统版本 | iStoreOS 25.12.5（build 2026092410） |
| 架构 | x86_64 |
| 包管理器 | **apk**（OpenWrt 新标准；`opkg` 兼容可用，安装新包用 `apk add <pkg>`） |
| 物理口分配 | eth0 = wan（公网拨号）/ eth1 = wan1（IPTV 拨号）/ eth2 + eth3 = lan（br-lan） |
| LAN 地址 | 192.168.1.1/24 |
| omcproxy | 固件预装 `omcproxy-2026.03.07~3abb601a-r1`（IGMPv3/MLDv2 Multicast Proxy，39 KiB），无需手动安装 |
| rtp2httpd | `3.13.5-r1`（iStore 在线安装，二进制 `/usr/bin/rtp2httpd` md5=`f0efcd7a8b9ab1c48eee63117ad34972`） |
| IPTV 网络助手插件 | 自研 `iptv-assistant 1.1.0`（`.run` 格式，Makeself 自解压包），源码见 `docs/iptv-assistant.run/` |
| AdGuardHome | iStoreOS 应用商店安装，监听 127.0.0.1:5253，dnsmasq 全网 DNS 上游 |

> ⚠️ iStoreOS 25.12 的 uhttpd(80) **不提供 /www 静态文件**服务，频道表经 rtp2httpd(:588) 或直接 App 源 `http://192.168.1.1/iptv.m3u` 获取（该路径由 rtp2httpd 的 external_m3u 同目录提供，见第 7/8 步）。

## 三、完整配置（现网生效值）

> **⚙️ 配置方式说明（二选一）**：第 2/3/4 节的三项 IPTV 核心优化（IGMPv2 强制、组播桥优化、FCC 快速换台路由）有两种**等价**的配置方式，每节内分别说明：
>
> - **方式一：IPTV 网络助手插件（推荐）** —— LuCI 图形界面（网络→IPTV 网络助手），参数持久化在 `/etc/config/iptv_assistant`；procd 监听 network 重载/开机事件自动补写运行时状态，根治「reload 后 sysfs/路由丢失」的坑。
> - **方式二：命令行手动配置** —— 直接写 sysctl / UCI / 静态路由，无插件依赖。
>
> ⚠️ **同一项功能只选一种，不要混用**：例如 FCC 路由插件已启用（fcc enabled=1）时不要再配 `network.fec` 静态路由，两套机制会写同一条路由互相打架。切换方式时先关掉旧的再启用新的。

### 第 1 步：配置网络接口（/etc/config/network）

**本步目标**：建好三个接口——公网 wan（拨号上网，metric=3 独占默认路由）、IPTV 专口 wan1（metric=20 进 IPTV 城域网、不抢默认路由）、lan（内网网关 192.168.1.1）。



```
# —— 公网 wan（metric=3，独占默认路由）——
network.wan=interface
network.wan.proto='pppoe'
network.wan.device='eth0'
network.wan.username='<公网宽带账号>'
network.wan.password='<公网宽带密码>'
network.wan.ipv6='auto'
network.wan.norelease='1'
network.wan.peerdns='0'
network.wan.dns='223.5.5.6' '119.29.29.29'
network.wan.metric='3'

# —— IPTV 专口 wan1（metric=20，不抢默认路由）——
network.wan1=interface
network.wan1.proto='pppoe'
network.wan1.device='wan1'          # 物理口，以 LuCI「网络→接口」实际绑定为准
network.wan1.username='<IPTV宽带账号>@iptv'
network.wan1.password='<IPTV宽带密码>'
network.wan1.ipv6='auto'
network.wan1.norelease='1'
network.wan1.defaultroute='0'      # 关键：不抢默认路由，上网仍走 wan
network.wan1.metric='20'

# —— lan（defaultroute=0：lan 口不装默认路由，仅网关自身）——
network.lan.proto='static'
network.lan.ipaddr='192.168.1.1'
network.lan.netmask='255.255.255.0'
network.lan.defaultroute='0'
network.lan.dns='223.5.5.5' '119.29.29.29'
```

> **WAN「网关跃点」= metric 的作用**：Linux 多出口时按 metric 从小到大选默认路由。wan=3 < wan1=20，上网流量永远走 wan；wan1(IPTV) 口没有默认路由、仅承载 `10.125.0.0/x` 与 FCC 静态路由。wan 侧 metric 若 ≥20 或 wan1 口不设 defaultroute=0，会导致上网流量误走 IPTV 城域网（无法访问公网）。

### 第 2 步：防火墙（/etc/config/firewall）

**本步目标**：把 IPTV 口 wan1 归入 lan 防火墙区——这是 omcproxy 能代理组播的前提（新路由器默认 lan 区只有 lan，必做）；再配置外网访问端口映射。



**lan 区必须包含 wan1**（omcproxy 跨区代理组播的前提；新路由器默认 lan 区只有 lan，**必做**）：

```
config zone
    option name 'lan'
    option input 'ACCEPT'
    option output 'ACCEPT'
    option forward 'ACCEPT'
    list network 'lan'
    list network 'wan1'        # ★ 关键：IPTV 口归入 lan 防火墙区
```

端口映射：

```
config redirect  # name='m3u'       888 → 192.168.1.1:80    公网下载频道表（reflection_src external）
config redirect  # name='rtp2httpd' 588 → 192.168.1.1:588   公网直接拉流
```

> IPTV 接口不属于任何防火墙区域时，omcproxy 无法跨区域代理组播/多播路由会受限，表现为拨号正常但频道无流。

### 第 3 步：IGMPv2 强制 + 内核缓冲（二选一）

**本步目标**：让 IPTV 拨号口强制使用 IGMPv2 并调大内核接收缓冲。



> force_igmp_version=2 是核心：不设的话客户端可能用 IGMPv3 加入，BRAS 不理，表现为换台黑屏久、看几分钟断流。

**方式一：IPTV 网络助手插件（推荐）**

LuCI「网络 → IPTV 网络助手」：

1. 打开 LuCI「网络 → IPTV 网络助手」
2. **全局设置**：最大接收缓冲区 = `16777216` / 默认接收缓冲区 = `2097152` / 网卡收包队列长度 = `5000`
3. **接口列表**：接口选 `pppoe-wan1`，IGMP 版本选 `v2`
4. 点「保存并应用」——插件自动生成 `/etc/sysctl.d/10-iptv-assistant.conf` 并生效

对应 UCI 配置（/etc/config/iptv_assistant）：

```ini
config globals 'globals'
	option enabled '1'
	option rmem_max '16777216'
	option rmem_default '2097152'
	option netdev_max_backlog '5000'

config interface 'iptv'
	option iface 'pppoe-wan1'       # wan1 的运行时 PPP 设备
	option igmp_version '2'         # 0=不强制
```

**方式二：命令行**

```bash
cat >> /etc/sysctl.conf <<'EOF'
net.ipv4.conf.pppoe-wan1.force_igmp_version=2
net.core.rmem_max=16777216
net.core.rmem_default=2097152
net.core.netdev_max_backlog=5000
EOF
sysctl -p /etc/sysctl.conf
```

验证（两种方式通用）：

```bash
sysctl net.ipv4.conf.pppoe-wan1.force_igmp_version   # = 2（公网口 pppoe-wan 不强制）
```

### 第 4 步：组播桥优化（br-lan snooping + querier，二选一）

**本步目标**：让 br-lan 桥只向有订阅的口转发组播，并由桥自己发 Query 维持订阅不老化。



> **必须两项同时开**：只开 snooping 不开 querier，约 260 秒后表项老化 → 看约 4 分钟断流。

**方式一：IPTV 网络助手插件（推荐）**

1. 打开 LuCI「网络 → IPTV 网络助手」→ **组播桥优化**
2. 桥选 `br-lan`
3. 「开启组播 Snooping」与「开启组播 Querier」两个开关都打开
4. 点「保存并应用」

对应 UCI 配置（/etc/config/iptv_assistant）：

```ini
config bridge 'bridge'
	option device 'br-lan'
	option snooping '1'             # 组播只送订阅口，不洪泛
	option querier '1'              # 桥发 IGMP Query 防订阅老化断流
```

插件 procd 监听 network 重载/开机事件**自动补写 sysfs**，无需手动 echo（根治「reload 后 UCI=1 但 sysfs=0」的坑）。

**方式二：命令行**

```bash
uci set network.@device[0].igmp_snooping='1'
uci set network.@device[0].multicast_querier='1'
uci commit network && /etc/init.d/network reload
```

⚠️ 命令行方式要注意落盘问题：`network reload` 后 querier 可能未生效到运行时（UCI=1 但 sysfs=0），必须核对并手动补写：

```bash
cat /sys/class/net/br-lan/bridge/multicast_snooping   # 应=1
cat /sys/class/net/br-lan/bridge/multicast_querier    # 应=1,若为 0 则手动补:
echo 1 > /sys/class/net/br-lan/bridge/multicast_querier
```

验证（两种方式通用）：**重启路由器后**再查一次 sysfs 两值均为 1。

### 第 5 步：FCC 快速换台路由（二选一）

**本步目标**：加一条到湖北电信 FCC 服务器（121.60.255.120）的静态路由，换台秒切。



**方式一：IPTV 网络助手插件（推荐）**

1. 打开 LuCI「网络 → IPTV 网络助手」→ **FCC 快速换台路由**
2. 启用 = 开，接口 = `wan1`，设备 = `自动（IPTV 拨号口，如 pppoe-wan1）`
3. 目标地址 = `121.60.255.120`，子网掩码 = `255.255.255.255`
4. 点「保存并应用」

对应 UCI 配置（/etc/config/iptv_assistant）：

```ini
config fcc 'fcc'
	option enabled '1'
	option interface 'wan1'         # IPTV 逻辑接口
	option target '121.60.255.120'  # 湖北电信 FCC 服务器
	option netmask '255.255.255.255'
```

插件用 `ip route replace` 管理内核路由，procd 双触发（插件配置变更 + network 重载）保活。

**方式二：命令行（/etc/config/network 静态路由）**

```bash
uci set network.fec=route
uci set network.fec.interface='wan1'
uci set network.fec.target='121.60.255.120'
uci set network.fec.netmask='255.255.255.255'
uci commit network && /etc/init.d/network reload
```

⚠️ **与插件互斥**：插件 fcc 启用期间不要配 `network.fec` 静态路由——两套机制写同一条路由，`network reload` 与插件触发器会互相覆盖。二选一。

验证（两种方式通用）：

```bash
ip route | grep 121.60    # 应有 121.60.255.120 dev pppoe-wan1 scope link
```

### 第 6 步：组播代理 omcproxy（/etc/config/omcproxy）

**本步目标**：omcproxy 把 IPTV 口的组播按 IGMP 订阅代理进 br-lan。



```
config proxy
	option scope global
	option uplink wan1
	list downlink lan
```

omcproxy 为 iStoreOS 25.12 固件预装（`apk info omcproxy` 可查版本），无需手动安装。进程核对：`ps w` 应见 `omcproxy pppoe-wan1 br-lan scope=global`。

> uplink 必须是 wan1（IPTV 拨号口）。若误配为 wan（公网口），IGMP 订阅发到公网口，频道无流。

### 第 7 步：rtp2httpd（/etc/config/rtp2httpd，LuCI「网络→rtp2httpd」可改）

**本步目标**：组播转 HTTP TS 流 + FCC 快速换台，App/网页播放都走它（端口 588）。



UCI 配置全量：

```
config rtp2httpd
	option disabled '0'
	option port '588'
	option verbose '1'
	option workers '4'
	option external_m3u 'file:///www/fcc.m3u'
	option buffer_pool_max_size '100000'
	option advanced_interface_settings '1'      # 启用组播/FCC 分接口指定
	option upstream_interface_multicast 'br-lan'
	option upstream_interface_fcc 'pppoe-wan1'
	option mcast_rejoin_interval '30'
	option udp_rcvbuf_size '2097152'
	option maxclients '30'
```

实际运行命令（由 init.d 读取 UCI 生成，`ps w` 可见）：

```
/usr/bin/rtp2httpd --noconfig --verbose 1 \
  --listen 588 \
  --upstream-interface-multicast br-lan \
  --upstream-interface-fcc pppoe-wan1 \
  --maxclients 30 --workers 4 \
  --buffer-pool-max-size 100000 \
  --udp-rcvbuf-size 2097152 \
  --external-m3u file:///www/fcc.m3u \
  --mcast-rejoin-interval 30
```

要点：

- **改参数用 `uci` 或 LuCI**（init.d 是标准 procd 脚本、读 UCI 生成命令行，不需要改脚本；改完 `/etc/init.d/rtp2httpd restart`）
- `--mcast-rejoin-interval 30`：每 30 秒重发 IGMP Join，配合桥 snooping 保持本机订阅
- FCC 走 pppoe-wan1 单播，组播走 br-lan
- 自启：`/etc/rc.d/S99rtp2httpd`；软件包 `rtp2httpd 3.13.5-r1`（iStore 在线版，二进制 md5=`f0efcd7a8b9ab1c48eee63117ad34972`，备份在 `docs/router_backup_20260906/rtp2httpd`，源停更时可救急）

**播放端订阅地址：`http://192.168.1.1:588/playlist.m3u`**（rtp2httpd 自动生成，132 频道，条目指向 `:588/rtp/...`）。

⚠️ **uhttpd(80) 在 iStoreOS 上不提供 `/www` 静态文件**：`http://192.168.1.1/fcc.m3u` 返回 404，App 播放列表源不要配这个地址。

### 第 8 步：频道表（/www/fcc.m3u 与 /www/iptv.m3u 双份）

**本步目标**：放置 132 频道播放列表：fcc.m3u 给 rtp2httpd 引用（必须存在），iptv.m3u 给 App 当播放源，两份内容相同。



| 项 | 值 |
| --- | --- |
| 规格 | 26773 字节 / 265 行 / 132 频道 |
| 本地备份 | `docs/router_backup_20260906/fcc.m3u` |
| 格式 | `http://192.168.1.1:588/rtp/239.254.96.96:8550?fcc=121.60.255.120:15970` |
| **路由器上双份文件** | `/www/fcc.m3u`（rtp2httpd external_m3u 引用，**必须存在**）+ `/www/iptv.m3u`（**App 播放列表源**，App 里配 `http://192.168.1.1/iptv.m3u`）。两份内容相同，更新时同步替换 |

格式模板（每个频道两行）：

```
#EXTINF:-1 tvg-id="1" tvg-name="CCTV1" tvg-logo="http://epg.51zmt.top:8000/tb1/CCTV/CCTV1.png" group-title="央视",CCTV1HD
http://192.168.1.1:588/rtp/239.254.96.96:8550?fcc=121.60.255.120:15970
```

- 组播地址 `239.x.x.x:port` 来自电信，换地区要重新抓
- `?fcc=121.60.255.120:15970` 是 FCC 快速换台服务器，依赖第 4 节的插件 FCC 路由

### 第 9 步：全网 DNS 链 dnsmasq → AdGuardHome

**本步目标**：全网 DNS 经 dnsmasq:53 转发 AdGuardHome:5253 过滤后出上游。



```
# /etc/config/dhcp @dnsmasq[0]（关键项）
option noresolv '1'              # 不读 resolv.conf，上游完全由 server 列表决定
list server '127.0.0.1#5253'     # 全部转发给 AdGuardHome(5253)
option localservice '0'
option rebind_protection '0'
option port '53'
```

> AdGuardHome 在 127.0.0.1:5253 监听并过滤后发往上游。**换新路由器必须重装 AdGuardHome（iStoreOS 应用商店）并恢复其配置，否则 dnsmasq 指向 5253 无人应答 → 全网断网断解析。** 这是迁移最易翻车的隐性依赖。

### 第 10 步：端到端验证

**本步目标**：全部配置完成后，逐项核对运行时状态并实测拉流（详细清单见第五节，核心三条如下）。

```bash
# 1) IPTV 拨号 + IGMPv2 + 桥 + FCC 路由
sysctl net.ipv4.conf.pppoe-wan1.force_igmp_version    # = 2
cat /sys/class/net/br-lan/bridge/multicast_querier    # = 1
ip route | grep 121.60                                # 121.60.255.120 dev pppoe-wan1

# 2) rtp2httpd 在跑 + 588 监听
ps w | grep -E 'omcproxy|rtp2httpd' | grep -v grep
netstat -lnt | grep 588

# 3) 真实拉流（局域网任意设备）
curl -o /dev/null -m 8 'http://192.168.1.1:588/rtp/239.254.96.96:8550?fcc=121.60.255.120:15970' && echo OK
```

## 四、换路由器迁移步骤（照抄执行）

> 最省事路径：旧机 iStoreOS「系统→备份/升级→生成配置备份」（含 /etc/config 与已装软件列表），新机恢复后再补装 AdGuardHome 数据。以下为备份不可用时的手动完整路径。

### 路径 A（推荐）：推送本地备份文件恢复

```bash
# —— 在 Mac 上执行（docs/router_backup_20260906/ 目录）——
cd docs/router_backup_20260906
for pair in \
  "config.network:/etc/config/network" \
  "config.firewall:/etc/config/firewall" \
  "config.dhcp:/etc/config/dhcp" \
  "config.omcproxy:/etc/config/omcproxy" \
  "config.udpxy:/etc/config/udpxy" \
  "config.rtp2httpd:/etc/config/rtp2httpd" \
  "fcc.m3u:/www/fcc.m3u"; do
  sshpass -p '密码' scp "./${pair%%:*}" "root@192.168.1.1:${pair##*:}"
done
# —— 在新路由器 SSH 里执行 ——
# ⚠️ iStoreOS 25.12 使用 apk 包管理器；omcproxy 固件预装，无需手动装
apk update 2>/dev/null || opkg update
apk add rtp2httpd luci-app-rtp2httpd 2>/dev/null || opkg install rtp2httpd luci-app-rtp2httpd
# IPTV 网络助手插件（IGMPv2 强制 / 桥优化 / FCC 路由）
# 上传 docs/iptv-assistant.run/ 构建出的 iptv-assistant_1.1.0_sdk_25.12_all.run 后：
sh iptv-assistant_1.1.0_sdk_25.12_all.run
# AdGuardHome 从 iStoreOS 应用商店安装并恢复配置（DNS 链依赖，见第 9 步）
/etc/init.d/udpxy disable 2>/dev/null
reboot   # 重启让 network/桥 querier 完整落盘，重启后过一遍第五节验证
```

> ⚠️ 路径 A 恢复的 network/firewall 口序是旧机器的；新机先在 LuCI 核对各接口绑定 device 再重启网络。
> ⚠️ wan 账号在 network 备份里若与新宽带不符，改 `network.wan.username/password`。

### 路径 B：全新系统逐条 UCI

```bash
# 0. 公网 wan 拨号（账号按新宽带实际填写；peerdns=0 固定上游 DNS）
uci set network.wan.proto='pppoe'
uci set network.wan.username='<公网宽带账号>'
uci set network.wan.password='<公网宽带密码>'
uci set network.wan.peerdns='0'
uci add_list network.wan.dns='223.5.5.6'
uci add_list network.wan.dns='119.29.29.29'
uci set network.wan.metric='3'

# 1. IPTV 口 wan1（device 按新机接 IPTV 的物理口改）
uci set network.wan1=interface
uci set network.wan1.proto='pppoe'
uci set network.wan1.device='wan1'
uci set network.wan1.username='<IPTV宽带账号>@iptv'
uci set network.wan1.password='<IPTV宽带密码>'
uci set network.wan1.defaultroute='0'
uci set network.wan1.metric='20'
uci set network.wan1.norelease='1'
uci commit network && /etc/init.d/network reload

# 2. ★ IPTV 归入 lan 防火墙区（@zone[0]=lan，可用 uci show firewall 确认）
uci add_list firewall.@zone[0].network='wan1'
uci commit firewall && /etc/init.d/firewall reload

# 3. omcproxy（iStoreOS 25.12 固件预装）
cat > /etc/config/omcproxy <<'EOF'
config proxy
    option scope global
    option uplink wan1
    list downlink lan
EOF
/etc/init.d/omcproxy enable && /etc/init.d/omcproxy restart

# 4. rtp2httpd
apk add rtp2httpd luci-app-rtp2httpd 2>/dev/null || opkg install rtp2httpd luci-app-rtp2httpd
uci set rtp2httpd.@rtp2httpd[0].disabled='0'
uci set rtp2httpd.@rtp2httpd[0].port='588'
uci set rtp2httpd.@rtp2httpd[0].verbose='1'
uci set rtp2httpd.@rtp2httpd[0].workers='4'
uci set rtp2httpd.@rtp2httpd[0].external_m3u='file:///www/fcc.m3u'
uci set rtp2httpd.@rtp2httpd[0].buffer_pool_max_size='100000'
uci set rtp2httpd.@rtp2httpd[0].advanced_interface_settings='1'
uci set rtp2httpd.@rtp2httpd[0].upstream_interface_multicast='br-lan'
uci set rtp2httpd.@rtp2httpd[0].upstream_interface_fcc='pppoe-wan1'
uci set rtp2httpd.@rtp2httpd[0].mcast_rejoin_interval='30'
uci set rtp2httpd.@rtp2httpd[0].udp_rcvbuf_size='2097152'
uci set rtp2httpd.@rtp2httpd[0].maxclients='30'
uci commit rtp2httpd
/etc/init.d/rtp2httpd enable && /etc/init.d/rtp2httpd restart

# 5. IGMPv2 强制 / 桥优化 / FCC 路由 —— 两种方式【二选一】，不要都做（见第三节开头说明）
#
# 5A. 方式一：IPTV 网络助手插件（推荐）
#     上传 docs/iptv-assistant.run/ 构建出的 .run 包后执行：
sh iptv-assistant_1.1.0_sdk_25.12_all.run
#     装完后在 LuCI「网络→IPTV 网络助手」确认：iface=pppoe-wan1、igmp_version=2、
#     桥 br-lan snooping/querier=1、fcc enabled=1 interface=wan1，点「保存并应用」
#
# 5B. 方式二：命令行（不装插件时用）
cat >> /etc/sysctl.conf <<'EOF'
net.ipv4.conf.pppoe-wan1.force_igmp_version=2
net.core.rmem_max=16777216
net.core.rmem_default=2097152
net.core.netdev_max_backlog=5000
EOF
sysctl -p /etc/sysctl.conf
uci set network.@device[0].igmp_snooping='1'
uci set network.@device[0].multicast_querier='1'
uci commit network && /etc/init.d/network reload
uci set network.fec=route
uci set network.fec.interface='wan1'
uci set network.fec.target='121.60.255.120'
uci set network.fec.netmask='255.255.255.255'
uci commit network && /etc/init.d/network reload
#     ⚠️ 命令行方式:reload 后 querier 可能未落盘,重启路由器后核对 sysfs(见第三节.3)

# 6. DNS 链（先在 iStoreOS 商店装 AdGuardHome，确认 5253 在监听，再做这步）
uci set dhcp.@dnsmasq[0].noresolv='1'
uci del_list dhcp.@dnsmasq[0].server='114.114.114.114' 2>/dev/null
uci add_list dhcp.@dnsmasq[0].server='127.0.0.1#5253'
uci set dhcp.@dnsmasq[0].rebind_protection='0'
uci commit dhcp && /etc/init.d/dnsmasq restart

# 7. 频道表：fcc.m3u + iptv.m3u 双份放回 /www/（本地备份 docs/router_backup_20260906/fcc.m3u）

# 8. 端口映射
uci add firewall redirect
uci set firewall.@redirect[-1].name='rtp2httpd'
uci set firewall.@redirect[-1].src='wan'
uci set firewall.@redirect[-1].src_dport='588'
uci set firewall.@redirect[-1].dest='lan'
uci set firewall.@redirect[-1].dest_ip='192.168.1.1'
uci set firewall.@redirect[-1].dest_port='588'
uci set firewall.@redirect[-1].proto='tcp'
uci add firewall redirect
uci set firewall.@redirect[-1].name='m3u'
uci set firewall.@redirect[-1].src='wan'
uci set firewall.@redirect[-1].src_dport='888'
uci set firewall.@redirect[-1].dest='lan'
uci set firewall.@redirect[-1].dest_ip='192.168.1.1'
uci set firewall.@redirect[-1].dest_port='80'
uci set firewall.@redirect[-1].proto='tcp'
uci set firewall.@redirect[-1].reflection_src='external'
uci commit firewall && /etc/init.d/firewall reload

# 9. udpxy 保持禁用
/etc/init.d/udpxy disable 2>/dev/null

# 10. 重启路由器，重启后过一遍第五节验证
```

## 五、验证命令清单

```bash
# IPTV 拨号
ifstatus wan1 | grep -E '"up"|address'        # up:true + 10.x 地址
# 默认路由走 wan（metric=3）
ip route | head -1
# IGMPv2 生效（插件生成）
sysctl net.ipv4.conf.pppoe-wan1.force_igmp_version   # = 2
# 桥 snooping/querier 运行时（重启后必查！）
cat /sys/class/net/br-lan/bridge/multicast_snooping  # = 1
cat /sys/class/net/br-lan/bridge/multicast_querier   # = 1
# FCC 路由（插件 ip route replace）
ip route | grep 121.60                        # 121.60.255.120 dev pppoe-wan1
# IPTV 在 lan 防火墙区（omcproxy 转发前提）
uci show firewall | grep "network='wan1'"     # 应落在 name='lan' 的 zone
# 进程 + 命令行核对
ps w | grep -E 'omcproxy|rtp2httpd' | grep -v grep
# 588 监听
netstat -lnt | grep 588
# DNS 链（本机经 dnsmasq→AdGuardHome 解析公网域名）
nslookup www.baidu.com 127.0.0.1
netstat -lnp | grep 5253                             # AdGuardHome 在听
# IGMP 活跃（应看到 iStoreOS.lan 发 Query、终端回 Report；周期约 125s，耐心等）
tcpdump -i br-lan -q igmp
# 实际拉流测试（在局域网任意设备）
curl -o /dev/null -m 8 'http://192.168.1.1:588/rtp/239.254.96.96:8550' && echo OK
# 带 FCC 的完整拉流（换台加速生效）
curl -o /dev/null -m 8 'http://192.168.1.1:588/rtp/239.254.96.96:8550?fcc=121.60.255.120:15970' && echo OK
# App 播放列表源
curl -s http://192.168.1.1/iptv.m3u | head -4
```

## 六、故障排查速查

| 症状 | 首查 | 常见原因 |
| --- | --- | --- |
| 换台黑屏久/看几分钟断 | `sysctl ...force_igmp_version` 是否=2 | 插件 interface 节未启用/接口名不对（v3 报文 BRAS 不认） |
| 看约 4 分钟准时断 | 桥 querier 是否=1 | 只开了 snooping 没开 querier，表项老化 |
| IPTV 拨上但频道无流 | lan 防火墙区是否含 wan1（第 2 步） | 新机默认 lan 区无 wan1，omcproxy 无法代理 |
| 完全无流 | `ifstatus wan1`；omcproxy 进程 | wan1 没拨上/omcproxy 挂了 |
| 全网网页打不开(解析失败) | `nslookup www.baidu.com 127.0.0.1`；5253 是否监听 | dnsmasq 指向 5253 但 AdGuardHome 未装/未起 |
| FCC 换台加速无效 | `ip route \| grep 121.60` | 插件 fcc 节未启用/接口不对，FCC 路由丢失 |
| 上网慢/部分网站不通 | `ip route \| head -1` 默认路由是否 pppoe-wan | wan metric ≥ 20 或 wan1 抢了默认路由 |
| LAN 口/WiFi 卡 | 桥 snooping 是否=1 | 泛洪回潮（重置/升级后丢配置，插件会自动补写） |
| 外网拉不了流 | firewall 588 映射 | 映射丢失或公网 IP 变了（家宽重拨） |
| App 加载频道表失败/超时 | App 源是否配 `http://192.168.1.1/iptv.m3u` | 误配 `/fcc.m3u`（uhttpd 不提供 /www 静态文件，404） |
| 重启路由后异常 | 第四节全量过一遍 | iStoreOS 升级/重置导致配置回退 |
