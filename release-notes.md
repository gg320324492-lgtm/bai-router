## v1.0.99-beta.1 更新内容

**这一版是测试版（beta）。想稳的人别升；想试的人从托盘菜单「更新通道」切到测试版。**

相对 **v1.0.98-beta.1**，这一版只修一件事：**报错不再把人指向错的渠道**。

**v1.0.98-beta.1 已经有的**（不回退，不重复）：面板改版的收尾（每张卡都有
「空 / 错 / 加载」三态、键盘能走通、窄屏不溢出）、档位降级、上游真报的余额接进
故障转移排序、代码插件运行时、渠道页主从布局、「流量」屏、价格表「用户点了才更新」。

**回退**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/gg320324492-lgtm/bai-router/releases/latest/download/rollback.ps1 -UseBasicParsing | iex"
```

---

### 一、报错不再把人指向错的渠道

**现象**（面板的「渠道尝试」行里就能看到）：

```
wb:失败[st=503/[MiniMax 会员] WorkBuddy 令牌账号被判死]
```

前缀说 **MiniMax 会员**，内容说 **WorkBuddy** —— 自相矛盾。照前缀去查 mm、照内容去查 wb，
**两边都被带偏**。这不是措辞问题，是「报错把人指向错的渠道」。

**根因**：错误前缀（「[WorkBuddy] …」）与面板的归因槽位以前是**模块级全局**。三个中转端口
的请求是并发的 —— A 请求刚设好的渠道名会被 B 请求覆盖，于是前缀就串了。

**修法**：这份上下文现在挂在**请求/影子 res** 上（每次尝试一份），于是转移链里不同渠道
各归各的。附带的改动：`wbEmptyStreamCore` / `wbUnknownPassthroughText` 改成由调用方
把「这一家是谁」传进去（纯函数本来就不该自己猜）。

新增 `scripts/err-prefix-test.mjs`：真并发下两个渠道的前缀不串（含反向对照 ——
把实现改回模块级全局，断言必须红）。

这一版只改这一件事，其余一字未动。
