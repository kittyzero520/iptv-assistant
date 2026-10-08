'use strict';
'require view';
'require form';
'require ui';
'require fs';
'require uci';

return view.extend({
	render: function() {
		return Promise.all([
			uci.load('iptv_assistant'),
			uci.load('network'),
			fs.read('/proc/net/dev')
		]).then(function(data) {
			let m, s, o;
			let procDev = data[2];
			let ifaces = [];

			/* 从 /proc/net/dev 收集真实网络接口名（过滤 lo 与常见虚拟接口） */
			if (procDev && typeof procDev == 'string') {
				procDev.split('\n').forEach(function(line) {
					let mt = line.match(/^\s*([^:\s]+):/);
					let name = mt && mt[1];
					if (name && name != 'lo' &&
					    !/^(dummy|gretap|erspan|ip6|tunl|teql|sit0|ifb|veth|docker|tailscale|zt|wg|wireguard|privoxy)/.test(name))
						ifaces.push(name);
				});
			}

			/* 已配置在 UCI 里的接口名也要出现在下拉框中，避免旧值丢失 */
			let cfg = uci.get('iptv_assistant') || {};
			Object.keys(cfg).forEach(function(sid) {
				let sec = uci.get('iptv_assistant', sid);
				if (sec && sec['.type'] == 'interface' && sec.iface && ifaces.indexOf(sec.iface) < 0)
					ifaces.push(sec.iface);
			});

			/* 读取失败时的兜底列表 */
			if (!ifaces.length)
				ifaces = ['eth0', 'eth1', 'wan', 'wan1', 'br-lan'];

			ifaces.sort();

			m = new form.Map('iptv_assistant', _('IPTV 网络助手'),
				_('湖北电信 IPTV 全链路工具：强制组播 IGMP 版本、优化内网桥组播转发、维护 FCC 快速换台路由。'
				  + '所有选项都有默认值，恢复默认即可回到推荐配置。'));

			/* ---- Globals section ---- */
			s = m.section(form.NamedSection, 'main', 'globals', _('全局设置'));
			s.addremove = false;

			o = s.option(form.Flag, 'enabled', _('启用插件'));
			o.default = '1';
			o.rmempty = false;

			o = s.option(form.Value, 'rmem_max', _('最大接收缓冲区'),
				_('对应内核参数 net.core.rmem_max。套接字接收缓冲区上限，值越大，组播突发时越不容易丢包。'));
			o.placeholder = '16777216';
			o.datatype = 'uinteger';

			o = s.option(form.Value, 'rmem_default', _('默认接收缓冲区'),
				_('对应内核参数 net.core.rmem_default。套接字接收缓冲区默认大小。'));
			o.placeholder = '2097152';
			o.datatype = 'uinteger';

			o = s.option(form.Value, 'netdev_max_backlog', _('网卡收包队列长度'),
				_('对应内核参数 net.core.netdev_max_backlog。每个 CPU 入方向最大排队包数。'));
			o.placeholder = '5000';
			o.datatype = 'uinteger';

			/* ---- Interface section (table, add/remove) ---- */
			s = m.section(form.TypedSection, 'interface', _('接口列表'),
				_('每一行对指定网络接口强制 IGMP 版本。版本选「默认」表示该接口不做任何修改。'));
			s.addremove = true;
			s.anonymous = true;
			s.template = 'cbi/tblsection';

			o = s.option(form.ListValue, 'iface', _('接口名'));
			ifaces.forEach(function(name) { o.value(name); });

			o = s.option(form.ListValue, 'igmp_version', _('IGMP 版本'));
			o.value('0', _('默认'));
			o.value('1', _('IGMPv1'));
			o.value('2', _('IGMPv2'));
			o.value('3', _('IGMPv3'));
			o.default = '2';

			/* ---- Bridge section (multicast snooping/querier) ---- */
			let bridges = ifaces.filter(function(n) { return n.indexOf('br-') == 0; });
			if (!bridges.length)
				bridges = ['br-lan'];

			s = m.section(form.NamedSection, 'bridge', 'bridge', _('组播桥优化'));
			s.addremove = false;

			o = s.option(form.ListValue, 'device', _('桥设备'));
			bridges.forEach(function(name) { o.value(name); });

			o = s.option(form.Flag, 'snooping', _('IGMP 侦听（snooping）'),
				_('开启后组播流只送往有订阅的接口，不再洪泛到内网所有设备。'));
			o.default = '1';
			o.rmempty = false;

			o = s.option(form.Flag, 'querier', _('组播查询员（querier）'),
				_('路由器定期发送 IGMP 查询维持订阅不老化。必须与侦听同时开启，否则约 4 分钟后组播断流。'));
			o.default = '1';
			o.rmempty = false;

			/* ---- FCC route section (fast channel change) ---- */
			let nets = [];
			let netcfg = uci.get('network') || {};
			Object.keys(netcfg).forEach(function(sid) {
				let sec = uci.get('network', sid);
				if (sec && sec['.type'] == 'interface' && sid != 'loopback')
					nets.push(sid);
			});
			if (nets.indexOf('wan1') < 0)
				nets.push('wan1');
			nets.sort();

			s = m.section(form.NamedSection, 'fcc', 'fcc', _('FCC 快速换台路由'));
			s.addremove = false;

			o = s.option(form.Flag, 'enabled', _('启用 FCC 路由'),
				_('把湖北电信 FCC 服务器（快速换台补帧服务器）的流量固定走 IPTV 拨号口。'
				  + '关闭后流量走公网口，快速换台失效，换台回到纯组播慢速模式。'));
			o.default = '1';
			o.rmempty = false;

			o = s.option(form.ListValue, 'interface', _('IPTV 逻辑接口'),
				_('FCC 服务器所在的专网接口（即 IPTV 拨号接口），通常选 wan1。'));
			nets.forEach(function(name) { o.value(name); });

			o = s.option(form.ListValue, 'device', _('运行时设备名（留空自动）'),
				_('一般选「自动」：插件按 pppoe-<接口名> 推导（如 pppoe-wan1）。仅当接口命名特殊导致推导失败时才手动指定。'));
			o.value('', _('自动（IPTV 拨号口，如 pppoe-wan1）'));
			ifaces.forEach(function(name) { o.value(name); });

			o = s.option(form.Value, 'target', _('FCC 服务器地址'),
				_('湖北电信 FCC 服务器 IP。恢复默认填 121.60.255.120。'));
			o.default = '121.60.255.120';
			o.placeholder = '121.60.255.120';
			o.datatype = 'ip4addr';

			o = s.option(form.Value, 'netmask', _('子网掩码'),
				_('恢复默认填 255.255.255.255（精确匹配单个服务器）。'));
			o.default = '255.255.255.255';
			o.placeholder = '255.255.255.255';
			o.datatype = 'ip4addr';

			/* ---- Save & Apply hook ---- */
			s.onSave = function() {
				/* trigger reload after UCI commit */
				ui.addNotification(null, _('正在重新加载 iptv-assistant 服务…'), 'info');
				fs.exec('/etc/init.d/iptv-assistant', ['reload']);
			};

			return m.render();
		});
	}
});
