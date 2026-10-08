# IPTV 网络助手（iptv-assistant）.run 包

iStoreOS 25.12 自解压安装器。**用途：湖北电信 IPTV 全链路助手**——强组播协议版本、优内网桥转发、保 FCC 快速换台，LuCI 全中文界面，所有参数带默认值可随时恢复。

## 插件用途（三大功能）

| 功能 | 解决什么问题 | 默认值 |
|---|---|---|
| **IGMP 版本强制** | 湖北电信 BRAS 只认 IGMPv2，不强制时客户端用 IGMPv3 加组 → 换台黑屏/几分钟断流 | 接口 `wan1`（运行时 `pppoe-wan1`）强制 IGMPv2 |
| **组播桥优化** | snooping=0 组播洪泛内网；无 querier 订阅约 4 分钟老化断流 | `br-lan` 上 snooping=1 + querier=1（必须同开） |
| **FCC 快速换台路由** | FCC 服务器 `121.60.255.120` 在 IPTV 专网，无路由则流量走公网口 → 快速换台失效 | 开启，`121.60.255.120/32` 走 `wan1` |
| **内核缓冲调优**（附带） | 组播突发易丢包 | rmem_max=16777216 / rmem_default=2097152 / netdev_max_backlog=5000 |

## 安装方式

### 方式 1:iStore 应用商店(推荐)

1. 打开 LuCI → iStore
2. 点「手动安装」
3. 上传 `iptv-assistant_1.1.0_sdk_25.12_all.run`
4. 等待完成

### 方式 2:命令行

```bash
scp iptv-assistant_1.1.0_sdk_25.12_all.run root@192.168.1.1:/tmp/
ssh root@192.168.1.1 'sh /tmp/iptv-assistant_1.1.0_sdk_25.12_all.run'
```

## 装了什么

| 路径 | 作用 |
|---|---|
| `/etc/config/iptv_assistant` | UCI 配置,改这里改参数 |
| `/etc/init.d/iptv-assistant` | procd 服务,`enable`/`start`/`reload`;监听 network 事件自动补写桥状态与路由 |
| `/etc/sysctl.d/10-iptv-assistant.conf` | 自动生成,`sysctl --system` 应用 |
| `/etc/uci-defaults/10-iptv-assistant` | 安装时种子配置(只在配置不存在时写) |
| `/usr/share/luci/menu.d/luci-app-iptv-assistant.json` | LuCI 菜单注册(Network → IPTV 网络助手) |
| `/usr/share/rpcd/acl.d/luci-app-iptv-assistant.json` | rpcd ACL(uci: iptv_assistant 读写 + network 只读;file: /proc/net/dev 读 + init.d 执行) |
| `/www/luci-static/resources/view/iptv_assistant.js` | LuCI view(client-side JavaScript,全中文) |

## LuCI 界面（Network → IPTV 网络助手）

- **全局设置**：启用插件 + 三个内核缓冲参数
- **接口列表**（表格，可增删）：接口下拉框（自动读真实接口）+ IGMP 版本下拉
- **组播桥优化**：桥设备下拉 + IGMP 侦听/组播查询员开关
- **FCC 快速换台路由**：启用开关 + IPTV 逻辑接口下拉 + 运行时设备名下拉（第一项「自动（IPTV 拨号口）」）+ 服务器地址 + 掩码
- 保存后自动 `/etc/init.d/iptv-assistant reload`，所有改动立即生效

## 配置默认值（恢复参照）

```ini
config globals 'main'
	option enabled '1'
	option rmem_max '16777216'
	option rmem_default '2097152'
	option netdev_max_backlog '5000'

config interface 'iptv'
	option iface 'pppoe-wan1'       # IPTV 拨号口（wan1 的运行时设备）
	option igmp_version '2'         # IGMPv2（湖北电信 BRAS 只认 v2）；0=不强制

config bridge 'bridge'
	option device 'br-lan'          # 内网桥
	option snooping '1'             # 组播只送订阅口
	option querier '1'              # 桥发 IGMP Query 防订阅老化

config fcc 'fcc'
	option enabled '1'              # 0=关闭并自动删路由
	option interface 'wan1'         # IPTV 逻辑接口
	option target '121.60.255.120'  # 湖北电信 FCC 服务器
	option netmask '255.255.255.255' # /32 精确匹配
```

## 构建

```bash
cd docs/iptv-assistant.run
sh build.sh
# 输出: iptv-assistant_1.1.0_sdk_25.12_all.run
```

格式:makeself 风格 shell header + gzip 压缩 tar。不依赖 makeself 工具,纯 `tar/gzip/sh` 手搓。

## 架构兼容性

`all` 架构——纯 shell + 配置文件 + JavaScript,无编译二进制。x86_64 / aarch64 全通吃。

## 卸载 iptv-assistant

```bash
/etc/init.d/iptv-assistant disable
/etc/init.d/iptv-assistant stop
rm -f /etc/init.d/iptv-assistant /etc/config/iptv_assistant /etc/uci-defaults/10-iptv-assistant /etc/sysctl.d/10-iptv-assistant.conf
rm -f /usr/share/luci/menu.d/luci-app-iptv-assistant.json /usr/share/rpcd/acl.d/luci-app-iptv-assistant.json /www/luci-static/resources/view/iptv_assistant.js
/etc/init.d/rpcd restart
reboot   # 彻底清干净已设的 sysctl 值与运行时路由
```
