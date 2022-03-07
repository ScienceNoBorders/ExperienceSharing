# 目录
[toc]
## 1、概述
### 1.1、初识IPFS
星际文件系统（InterPlanetary File System，缩写为IPFS）是一个旨在实现文件的分布式存储、共享和持久化的网络传输协议。它是一种内容可寻址的对等超媒体分发协议[^1]。 
+ 首先，IPFS是一个FS(文件系统)。
+ 它是一种网络传输协议，与超文本协议(http)类似。
+ 它支持点对点(p2p)传输。
+ 它是一种去中心化的区块链技术，每个节点都是独立的中心。

目前互联网大量依靠 HTTP 协议进行通讯，HTTP 协议由蒂姆·伯纳斯-李于1989年在欧洲核子研究组织（CERN）所发起，至今已经快30年，它的不足逐渐显露了出来[^2]：
+ HTTP 的中心化是低效的, 并且成本很高。
+ 网络上的文件经常被删除。
+ 中心化限制了 Web 的成长。
+ 网络上的应用高度依赖主干网。  

为了解决以上的问题，IPFS 应运而生，它将为我们构建一个更快、更健壮和更安全的存储网络。

### 1.2、IPFS 与 Protocol Labs
Protocol Labs 成立于2014年5月，由 IPFS 和 Filecoin 的发明人 Juan Benet 创立。那年夏天，Protocol Labs 参加了 [YCombinator](https://ycombinator.com/) 计划（S14）。他们通过新的技术突破，出色的用户体验设计和开源的创作方法来解决互联网文件系统的问题。在他们看来，互联网是人类最重要的技术，他们致力于信息的存储、定位和就传输。 IPFS项目的成功，离不开Protocol Labs团队和开源社区的努力，一个项目的成功不可能只依靠个人，开源社区集合了大量的贡献者，将他们的超凡学识和过人技能分享给世界，让项目更加完善并取得突破。每一个项目背后都是贡献者的努力付出的成果。
<div style="text-align: center">
<img src="./images/1.0-ProtocolLabs-projects.png"/>
</div>

Protocol Labs 目前包括五个项目，项目彼此独立又联系，就目前来说，这个家族成员都在为了更安全、高效、开放的网络而努力。它们分别是：

+ IPFS：星际文件系统，一个旨在创建持久且分布式存储和共享文件的网络传输协议。
+ FileCoin[^3]：IPFS 的激励项目，一个加密货币驱动的存储网络。矿工通过为分布式存储网络提供开放的硬盘空间，赚取 Filecoin；用户则花费 Filecoin，将文件加密存储于去中心化网络。
+ Libp2p[^4]： 模块化的网络堆栈项目。libp2p 汇集了各种传输和点对点协议，使开发人员可轻松构建大型，稳定的p2p网络。
+ IPLD[^5]：分布式网络数据模型. 它通过加密哈希算法连接数据，以更好实现数据交换和链接。
+ Multiformats[^6]：安全系统的协议集合，自我描述格式可以让系统互相协作和升级。
  
### 1.3、IPFS系统架构
<div style="text-align: center">
<img src="./images/02.jpg"/>
</div>
IPFS 采取分层模块化的设计方案，每个模块都可以有多种实现。IPFS 一共分为5层：

+ naming 基于 PKI 的一个命名空间(IPNS)。
+ merkledag IPFS 内部的逻辑数据结构格式
+ exchange 节点之间数据的交换和复制
+ routing 用于节点和对象寻址
+ network 用于节点的连接和数据的传输

### 1.3.1、IPFS network
网络层负责在IPFS节点之间提供点对点传输（可靠或者不可靠）。 它的任务主要是：
+ NAT穿透： UDP和TCP打洞、端口映射或者 TURN的方式。
+ 支持多种网络协议: TCP, SCTP, UTP, ...
+ 支持数据加密，签名和信道释放
+ 支持多路复用：复用连接，流，协议，节点，......

### 1.3.2、IPFS routing
IPFS 路由层有两个重要目的：
+ 节点寻址：寻找其他节点
+ 内容寻址：寻找发布在网络中的内容  

路由层可以针对不同的场景采用不同的实现，例如：
+ DHT：在网络中采用分布式的方式缓存路由记录
+ mdns：用于本地查找
+ snr：采用委派寻址，委托给超级节点，让它来帮助寻址
+ dns：IPFS 可以在 dns 之上进行寻址

### 1.3.3、IPFS exchange
IPFS 交换层负责数据的传输，一旦节点互相连接上，交换协议就会开始对数据的传输进行控制。同样的交换层也可以有多种实现方式：

+ Bitswap：IPFS 的主要交换协议
+ HTTP：基于 http 协议实现的简单数据交换方式

### 1.3.4、IPFS merkledag
<div style="text-align: center">
<img src="./images/04.png"/>
</div>
Merkle DAG拥有如下的功能： 

+ 内容寻址：使用多重哈希来唯一识别一个数据块的内容
+ 防篡改：可以方便的检查哈希值来确认数据是否被篡改
+ 去重：由于内容相同的数据块哈希是相同的，可以很容去掉重复的数据，节省存储空间

在 IPFS 网络中，存储文件时，首先会将文件切片，切割成 256KB 大小的文件。之后循环调用`MerkleDAG.Add`方法构建文件 MerkleDAG。 文件 hash 值创建流程：
+ 将切片之后的文件进行`sha-256`运算
+ 将运算结果选取0~31位
+ 将选取结果根据`base58`编码，运算结果前追加 Qm 即为最后结果，作为文件的 Hash 值

### 1.3.5、IPFS naming
IPFS 基于内容寻址，文件被切分成多个 block, 每个 block 通过 hash 运算得到唯一的 ID， 方便在网络中进行识别和去重。考虑到传输效率， 同一个 block 可能有多个 copy, 分别存储在不同的网络节点上。 每个 block 都有唯一的 ID，我们只需要根据节点的 ID 就可以获取到它所对应的 block。

在 IPFS 中，一个文件的 Hash 值完全取决于其内容，修改它的内容，其相应的 Hash 值也会发生改变。如果我们把修改前后的文件都添加到 IPFS 网络中，那么我们将可以通过这两个 Hash 值访问到前后两个版本的内容。这种静态特性有利于提高数据的安全，比如 Alice 可以将一份自己签名(私钥加密)的文件放到 IPFS 中，那么即使她后来对文件进行了修改并重新签名和发布，那么之前的文件依然存在，她不能抵赖曾经发布过老版本的文件。但对于一些需要保持动态性的文件来说，比如网页，在新版本出现后，旧版本的内容将毫无意义。并且，总不能要求网页访问者每次要在浏览器中输入不同的 IPFS 地址来访问不同时期的网页吧。

IPNS(Inter-Planetary Naming System)提供了一种为文件增加动态性的解决方案。它允许节点的 PeerID 限定的命名空间提供一个指向具体 ipfs 文件(目录) Hash 的指针，通过改变这个指针每次都指向最新的文件内容，可以使得其他人始终访问最新的内容。

---

站在数据的角度，我们可以换一种方式来理解 IPFS 的协议[^7]：
<div style="text-align: center">
<img src="./images/03.png"/>
</div>
IPLD(InterPlanetary Linked Data)主要用来定义数据,给数据建模;
libp2p解决的是数据如何传输的问题。下面分别介绍IFPS 中的2个主要部分IPLD 和 libP2P。

### 1.3.6、IPLD
通过hash 值来实现内容寻址的方式在分布式计算领域得到了广泛的应用， 比如区块链， 再比如git repo。 虽然使用hash 连接数据的方式有相似之处， 但是底层数据结构并不能通用， IPFS 是个极具野心的项目， 为了让这些不同领域之间的数据可互操作， 它定义了统一的数据模型IPLD， 通过它， 可以方便地访问来自不同领域的数据。 
<div style="text-align: center">
<img src="./images/05.png"/>
</div>
前面已经介绍数据的逻辑结构是用merkledag表示的， 那么它是如何实现的呢？ 围绕merkledag作为核心， 它定义了以下几个概念：

+ merkle link 代表dag 中的边
+ merkel-dag 有向无环图
+ merkle-path 访问dag节点的类似unix path的路径
+ IPLD data model 基于json 的数据模型
+ IPLD serialized format 序列化格式

我们知道，数据是多样性的，为了给不同的数据建模， 我们需要一种通用的数据格式， 通过它可以最大程度地兼容不同的数据， IPFS 中定义了一个抽象的集合， multiformat, 包含multihash、multiaddr、multibase、multicodec、multistream几个部分。

- （一）multihash
  自识别hash, 由3个部分组成，分别是：hash函数编码、hash值的长度和hash内容， 下面是个简单的例子：
    <div style="text-align: center">
        <img src="./images/06.png"/>
    </div>
    这种设计的最大好处是非常方便升级，一旦有一天我们使用的hash 函数不再安全了， 或者发现了更好的hash 函数，我们可以很方便的升级系统。  

- （二）multiaddr
    自描述地址格式，可以描述各种不同的地址
    <div style="text-align: center">
        <img src="./images/07.png"/>
    </div>  

- （三）multibase  
    multibase 代表的是一种编码格式， 方便把CID 编码成不同的格式， 比如这里定义了2进制、8进制、10进制、16进制、也有我们熟悉的base58btc 和 base64编码。
    <div style="text-align: center">
        <img src="./images/08.png"/>
    </div>  
- （四）multicodec
    mulcodec 代表的是自描述的编解码， 其实是个table， 用1到2个字节定了数据内容的格式， 比如用字母z表示base58btc编码， 0x50表示protobuf 等等。
    <div style="text-align: center">
        <img src="./images/09.png"/>
    </div>  
 - （五）multistream
    multistream 首先是个stream， 它利用multicodec，实现了自描述的功能， 下面是基于一个javascript 的例子； 先new 一个buffer 对象， 里面是json对象， 然后给它加一个前缀protobuf, 这样这个multistream 就构造好了， 可以通过网络传输。在解析时可以先取codec 前缀，然后移除前缀， 得到具体的数据内容。
    <div style="text-align: center">
        <img src="./images/10.png"/>
    </div>  
---
结合上面的部分， 我们重点介绍一下CID。
CID 是IPFS分布式文件系统中标准的文件寻址格式，它集合了内容寻址、加密散列算法和自我描述的格式, 是IPLD 内部核心的识别符。目前有2个版本，CIDv0 和CIDv1。

CIDv0是一个向后兼容的版本，其中:

* multibase 一直为 base58btc
* multicodec 一直为 protobuf-mdag
* version 一直为 CIDv0
* multihash 表示为cidv0 ::= `<multihash-content-address>`

为了更灵活的表述ID数据， 支持更多的格式， IPLD 定义了CIDv1，CIDv1由4个部分组成：
<div style="text-align: center">
    <img src="./images/11.png"/>
</div>
IPLD 是IPFS 的数据描述格式， 解决了如何定义数据的问题， 下面这张图是结合源代码整理的一份逻辑图，我们可以看到上面是一些高级的接口， 比如file, mfs, fuse 等。 下面是数据结构的持久化部分，节点之间交换的内容是以block 为基础的， 最下面就是物理存储了。比如block 存储在blocks 目录， 其他节点之间的信息存储在leveldb， 还有keystore, config 等。  
<div style="text-align: center">
    <img src="./images/12.png"/>
</div>

### 1.3.7、libP2P
<div style="text-align: center">
    <img src="./images/13.png" width="50%"/>
</div>
做过socket编程的小伙伴应该都知道， 使用raw socket 编程传输数据的过程，无非就是以下几个步骤：

1. 获取目标服务器地址
2. 和目标服务器建立连接
3. 握手协议
4. 传输数据
5. 关闭连接

libP2P 也是这样，不过区别在于它把各个部分都模块化了， 定义了通用的接口， 可以很方便的进行扩展。

- (一) 架构图
    <div style="text-align: center">
        <img src="./images/14.png"/>
    </div>
- (二) Peer Routing
    libP2P定义了routing 接口，目前有2个实现，分别是KAD routing 和 MDNS routing, 扩展很容易， 只要按照接口实现相应的方法即可。
    ipfs 中的节点路由表是通过维护多个K-BUCKET来实现的， 每次新增节点， 会计算节点ID 和自身节点ID 之间的common prefix, 根据这个公共前缀把节点加到对应的KBUCKET 中, KBUCKET 最大值为20， 当超出时，再进行拆分。
    <div style="text-align: center">
        <img src="./images/15.png"/>
    </div>
    更新路由表的流程如下：
    <div style="text-align: center">
        <img src="./images/16.png"/>
    </div>
    除了KAD routing 之外， IPFS 也实现了MDNS routing, 主要用来在局域网内发现节点, 这个功能相对比较独立， 由于用到了多播地址， 在一些公有云部署环境中可能无法工作。
- (三) Swarm（传输和连接）
    swarm 定义了以下接口：
    - transport 网络传输层的接口
    - connection 处理网络连接的接口
    - stream multiplex 同一connection 复用多个stream的接口

    下面我们重点看下是如何动态协商stream protocol 的，整个流程如下：
    <div style="text-align: center">
        <img src="./images/17.png"/>
    </div>
    默认先通过multistream-select 完成握手。发起方尝试使用某个协议， 接收方如果不接受， 再尝试其他协议， 直到找到双方都支持的协议或者协商失败。另外为了提高协商效率， 也提供了一个ls 消息， 用来查询目标节点支持的全部协议。
- (四) Distributed Record Store
    record 表示一个记录， 可以用来存储一个键值对，比如ipns name publish 就是发布一个objectId 绑定指定 node id 的record 到ipfs 网络中， 这样通过ipns 寻址时就会查找对应的record, 再解析到objectId, 实现寻址的功能。

- (五) Discovery
    目前系统支持3种发现方式， 分别是：

    - bootstrap 通过配置的启动节点发现其他的节点
    - random walk 通过查询随机生成的peerID， 从而发现新的节点
    - mdns 通过multicast 发现局域网内的节点
    
    最后总结一下源代码中的逻辑模块，从下到上分为5个层次:

    - 最底层为传输层， 主要封装各种协议， 比如TCP，SCTP， BLE， TOR 等网络协议
    - 传输层上面封装了连接层，实现连接管理和通知等功能
    - 连接层上面是stream 层， 实现了stream的多路复用
    - stream层上面是路由层
    - 最上层是discovery, messaging以及record store 等
### 1.3.8、IPFS存储文件步骤
1. 把单个文件拆分成若干个256KB大小的块（ block，这个就可以理解成扇区 ）；
2. 逐块(block)计算block hash，hashn = hash ( blockn )；
3. 把所有的block hash拼凑成一个数组，再计算一次hash，便得到了文件最终的hash，hash ( file ) = hash ( hash1……n )，并将这个 hash（file） 和block hash数组“捆绑”起来，组成一个对象，把这个对象当做一个索引结构；
4. 把block、索引结构全部上传给IPFS节点，文件便同步到了IPFS网络了；
5. 把 Hash（file）打印出来，读的时候用；

## 2、安装go-ipfs
### 2.1、go语言环境安装
安装包下载地址为[^8]：https://golang.google.cn/dl/
<div style="text-align: center">
    <img src="./images/18.png"/>
</div>

- **UNIX/Linux/Mac OS X, 和 FreeBSD 安装**
    1. 下载tar.gz源码包。
    2. 将下载的二进制包解压至 /usr/local目录。  
        > tar -C /usr/local -xzf go1.17.8.src.tar.gz
    3. 将/usr/local/go/bin目录添加至PATH环境变量，可以编辑`～/.bash_profile`或者`/etc/profile`文件，并将以下命令添加该文件的末尾。
        ```shell
        export PATH=$PATH:/usr/local/go/bin
        export GOPATH=~/go
        ```
        
        添加后执行命令生效
        >source ~/.bash_profile
         或
         source /etc/profile

    *注意：MAC 系统下你可以使用 .pkg 结尾的安装包直接双击来完成安装，安装目录在 /usr/local/go/ 下。*
- **Windows下安装**
    Windows 下可以使用 .msi 后缀(在下载列表中可以找到该文件，如go1.17.8.windows-amd64.msi)的安装包来安装。

    默认情况下 .msi 文件会安装在 c:\Go 目录下。你可以将 c:\Go\bin 目录添加到 Path 环境变量中，以及添加`GOPATH`变量，路径可以自定义。添加后你需要重启命令窗口才能生效。

*安装配置完毕后在终端运行`go version`命令查看是否安装成功！*
``` shell
$ go version
go version go1.16.14 darwin/amd64
```

### 2.2、安装go-ipfs
下载链接：https://dist.ipfs.io/#go-ipfs
<div style="text-align: center">
    <img src="./images/19.png"/>
</div>

- **UNIX/Linux/Mac OS X, 和 FreeBSD 安装**
    1. 下载对应系统的安装包
    2. 当你下载好安装包之后，解压并将ipfs的库文件拷到可执行的路径下，使用install.sh脚本进行安装：
        ``` shell
        tar xvfz go-ipfs.tar.gz
        cd go-ipfs
        ./install.sh
        ```
    3. 测试一下
       ``` shell
       $ ipfs version
       ipfs version 0.12.0
       ```
-  **Windows下安装**
    1. 下载Windows安装包。
    2. 解压后将ipfs.exe文件复制到C:\Windows\System32目录。
    3. 打开cmd命令窗口运行`ipfs version`测试
-  **使用ipfs-update升级IPFS**[^9]

### 2.3、运行IPFS
1. 使用`ipfs init`命令初始化IPFS仓库，Linux系统生成在`~/.ipfs`，Windows系统生成在`C:\User\.ipfs`。
    在~/.ipfs中，会生成如下几个文件：
    - blocks：本地仓库存储的CID文件块链接目录
    - keystore：密钥对文件存储目录
    - datastore：LevelDB数据文件目录
    - config：配置文件(非目录),json格式
    - version：文件，记录当前IPFS的版本号

2. 运行`ipfs daemon`命令
   ```shell
   $ ipfs daemon
    Initializing daemon...
    go-ipfs version: 0.12.0
    Repo version: 12
    System version: amd64/darwin
    Golang version: go1.16.12
    Swarm listening on /ip4/127.0.0.1/tcp/4001
    Swarm listening on /ip4/127.0.0.1/udp/4001/quic
    Swarm listening on /ip4/192.168.79.82/tcp/4001
    Swarm listening on /ip4/192.168.79.82/udp/4001/quic
    Swarm listening on /ip6/::1/tcp/4001
    Swarm listening on /ip6/::1/udp/4001/quic
    Swarm listening on /p2p-circuit
    Swarm announcing /ip4/127.0.0.1/tcp/4001
    Swarm announcing /ip4/127.0.0.1/udp/4001/quic
    Swarm announcing /ip4/192.168.79.82/tcp/4001
    Swarm announcing /ip4/192.168.79.82/udp/4001/quic
    Swarm announcing /ip6/::1/tcp/4001
    Swarm announcing /ip6/::1/udp/4001/quic
    API server listening on /ip4/192.168.79.82/tcp/5001
    WebUI: http://127.0.0.1:5001/webui
    Gateway (readonly) server listening on /ip4/127.0.0.1/tcp/8080
    Daemon is ready
   ```
3. 在浏览器中输入`http://127.0.0.1:5001/webui`可以打开IPFS的WebUI界面
    <div style="text-align: center">
        <img src="./images/20.png"/>
    </div>

## 3、配置ipfs-config
当使用`ipfs init`命令后会在.ipfs文件下生成一个config文件
``` json
{
  "API": {   // 节点API配置
    "HTTPHeaders": {}
  },
  "Addresses": {   // 节点网络通信multiaddress配置
    "API": "/ip4/0.0.0.0/tcp/5001",
    "Announce": [],
    "Gateway": "/ip4/0.0.0.0/tcp/8080",
    "NoAnnounce": [],
    "Swarm": [
      "/ip4/0.0.0.0/tcp/4001",
      "/ip6/::/tcp/4001",
      "/ip4/0.0.0.0/udp/4001/quic",
      "/ip6/::/udp/4001/quic"
    ]
  },
  "AutoNAT": {},
  "Bootstrap": [   // 中继节点multiaddress配置
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
    "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
    "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
    "/ip4/104.131.131.82/udp/4001/quic/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ"
  ],
  "Datastore": {  // 存储配置
    "BloomFilterSize": 0,
    "GCPeriod": "1h",
    "HashOnRead": false,
    "Spec": {
      "mounts": [
        {
          "child": {
            "path": "blocks",
            "shardFunc": "/repo/flatfs/shard/v1/next-to-last/2",
            "sync": true,
            "type": "flatfs"
          },
          "mountpoint": "/blocks",
          "prefix": "flatfs.datastore",
          "type": "measure"
        },
        {
          "child": {
            "compression": "none",
            "path": "datastore",
            "type": "levelds"
          },
          "mountpoint": "/",
          "prefix": "leveldb.datastore",
          "type": "measure"
        }
      ],
      "type": "mount"
    },
    "StorageGCWatermark": 90,
    "StorageMax": "10GB"
  },
  "Discovery": {  // LibP2P Discovery局域网内发现配置
    "MDNS": {
      "Enabled": true,
      "Interval": 10
    }
  },
  "Experimental": {   // 实验功能开关配置
    "FilestoreEnabled": false,
    "GraphsyncEnabled": false,
    "Libp2pStreamMounting": false,
    "P2pHttpProxy": false,
    "ShardingEnabled": false,
    "StrategicProviding": false,
    "UrlstoreEnabled": false
  },
  "Gateway": {   // HTTP 网关配置
    "APICommands": [],
    "HTTPHeaders": {
      "Access-Control-Allow-Headers": [
        "X-Requested-With",
        "Range",
        "User-Agent"
      ],
      "Access-Control-Allow-Methods": [
        "GET"
      ],
      "Access-Control-Allow-Origin": [
        "*"
      ]
    },
    "NoDNSLink": false,
    "NoFetch": false,
    "PathPrefixes": [],
    "PublicGateways": null, // 公共网关
    "RootRedirect": "",
    "Writable": false
  },
  "Identity": {  // 节点身份信息
    "PeerID": "12D3KooWSVzdPE1nXHAh9CyqAayFA8psJ9n6DwTkByiD8gWnm9b1",
    "PrivKey": "CAESQMQL3NrWkdjsQ++yxdWvlnCSaltDpYTKRA4+CRZhibgQ9+Hd9lslOXRd0pF4dqCtOIMHMpgtbTVaqba5bfOqYeQ="
  },
  "Ipns": {   // Ipns配置
    "RecordLifetime": "",
    "RepublishPeriod": "",
    "ResolveCacheSize": 128
  },
  "Mounts": {  // 文件系统挂载配置
    "FuseAllowOther": false,
    "IPFS": "/ipfs",
    "IPNS": "/ipns"
  },
  "Peering": { // 对等节点设置
    "Peers": null
  },
  "Pinning": {
    "RemoteServices": {}
  },
  "Plugins": {
    "Plugins": null
  },
  "Provider": {
    "Strategy": ""
  },
  "Pubsub": {
    "DisableSigning": false,
    "Router": ""
  },
  "Reprovider": {
    "Interval": "12h",
    "Strategy": "all"
  },
  "Routing": {
    "Type": "dht"
  },
  "Swarm": {  // P2P Swarm配置
    "AddrFilters": null,
    "ConnMgr": {
      "GracePeriod": "20s",
      "HighWater": 900,
      "LowWater": 600,
      "Type": "basic"
    },
    "DisableBandwidthMetrics": false,
    "DisableNatPortMap": false,
    "EnableAutoRelay": false,
    "EnableRelayHop": false,
    "Transports": {
      "Multiplexers": {},
      "Network": {},
      "Security": {}
    }
  }
}
```
私有网络需要更改配置文件的地方为以下几个
```json
"Addresses": {
    "Swarm": [
      "/ip4/0.0.0.0/tcp/4001",
      "/ip6/::/tcp/4001",
      "/ip4/0.0.0.0/udp/4001/quic",
      "/ip6/::/udp/4001/quic"
    ],
    "Announce": [],
    "AppendAnnounce": [],
    "NoAnnounce": [],
    "API": "/ip4/192.168.79.82/tcp/5001", //更改为本机局域网ip
    "Gateway": "/ip4/127.0.0.1/tcp/8080"
  },
  // 将bootstrap外网节点链接删除，改为局域网内节点，初始节点不必设置此值，置空即可
  // 格式为 /ipfs/IP地址/tcp/swarm端口号/ipfsID
  "Bootstrap": [ 
      "/ip4/10.0.12.9/tcp/4001/ipfs/12D3KooWKrRjxMHsCV4BHniK1XsKRo3vw1gLL4NLjHMptdHCED26"
  ],
  // 跨域设置
  "API": {
  	"HTTPHeaders": {
  		"Access-Control-Allow-Credentials": [
  			"true"
 		],
  		"Access-Control-Allow-Headers": [
  			"Authorization"
  		],
  		"Access-Control-Allow-Methods": [
  			"PUT",
  			"GET",
  			"POST",
  			"OPTIONS"
  		],
  		"Access-Control-Allow-Origin": [
  			"*"
  		],
  		"Access-Control-Expose-Headers": [
  			"Location"
  	    ]
 	}
  },
```
## 4、ipfs基本操作及命令
- ipfs add ---添加文件
  ``` shell
  $ ipfs add ipfs-logo.svg
  added QmXopKxE8ZcTTh23jVE1rbtF9u46jUBQaSrM31CRx9nnUy ipfs-logo.svg
   20.30 MiB / 20.30 MiB [=======================================================] 100.00%
  ```
- ipfs get ---下载文件
    ``` shell
    $ ipfs get QmXopKxE8ZcTTh23jVE1rbtF9u46jUBQaSrM31CRx9nnUy -o ipfs-logo.svg
    Saving file(s) to ipfs-logo.svg
     20.30 MiB / 20.30 MiB [====================================================] 100.00% 0s
    ```
- ipfs cat ---查看文件
    ``` shell
    $ ipfs cat QmXopKxE8ZcTTh23jVE1rbtF9u46jUBQaSrM31CRx9nnUy
    ```
- ipfs swarm peers ---查看连接节点
    ``` shell
    $ ipfs swarm peers --latency
    /ip4/192.168.14.105/udp/4001/quic/p2p/12D3KooWHRJck919AC4JK4fGHuhcYbVAVL3upa6j4Ns1wiHLanP5 24.254241ms
    /ip4/192.168.79.38/tcp/41358/p2p/QmUBb3ygTnUzW4MJi61yygDTMqT3YKKJbvo5ETSp1qasKc 54.277053ms
    /ip4/192.168.79.38/udp/40459/quic/p2p/QmUBb3ygTnUzW4MJi61yygDTMqT3YKKJbvo5ETSp1qasKc 54.277053ms
    ```
- ipfs dht findprovs ---查看文件存储信息
    ``` shell
    $ ipfs dht findprovs QmXopKxE8ZcTTh23jVE1rbtF9u46jUBQaSrM31CRx9nnUy
    12D3KooWFyiFwV7Ptp73kKgLGNVNGQnkyaJoaUoSMHiCdt9YSpQT
    QmUBb3ygTnUzW4MJi61yygDTMqT3YKKJbvo5ETSp1qasKc
    ```
- ipfs id ---获取节点信息
  ```json
  {
	"ID": "12D3KooWFyiFwV7Ptp73kKgLGNVNGQnkyaJoaUoSMHiCdt9YSpQT",
	"PublicKey": "CAESIFuLEG+VCOPki7+f2T2WQrHQvMTJIefEGqbv6UfCRXyE",
	"Addresses": [
		"/ip4/127.0.0.1/tcp/4001/p2p/12D3KooWFyiFwV7Ptp73kKgLGNVNGQnkyaJoaUoSMHiCdt9YSpQT",
		"/ip4/127.0.0.1/udp/4001/quic/p2p/12D3KooWFyiFwV7Ptp73kKgLGNVNGQnkyaJoaUoSMHiCdt9YSpQT",
		"/ip4/192.168.79.82/tcp/4001/p2p/12D3KooWFyiFwV7Ptp73kKgLGNVNGQnkyaJoaUoSMHiCdt9YSpQT",
		"/ip4/192.168.79.82/udp/4001/quic/p2p/12D3KooWFyiFwV7Ptp73kKgLGNVNGQnkyaJoaUoSMHiCdt9YSpQT",
		"/ip6/::1/tcp/4001/p2p/12D3KooWFyiFwV7Ptp73kKgLGNVNGQnkyaJoaUoSMHiCdt9YSpQT",
		"/ip6/::1/udp/4001/quic/p2p/12D3KooWFyiFwV7Ptp73kKgLGNVNGQnkyaJoaUoSMHiCdt9YSpQT"
	],
	"AgentVersion": "go-ipfs/0.12.0/",
	"ProtocolVersion": "ipfs/0.1.0",
	"Protocols": [
		"/ipfs/bitswap",
		"/ipfs/bitswap/1.0.0",
		"/ipfs/bitswap/1.1.0",
		"/ipfs/bitswap/1.2.0",
		"/ipfs/id/1.0.0",
		"/ipfs/id/push/1.0.0",
		"/ipfs/lan/kad/1.0.0",
		"/ipfs/ping/1.0.0",
		"/libp2p/autonat/1.0.0",
		"/libp2p/circuit/relay/0.1.0",
		"/libp2p/circuit/relay/0.2.0/stop",
		"/p2p/id/delta/1.0.0",
		"/x/"
	]
  }
  ```
- ipfs p2p listener ls ---通过libp2p创建并使用隧道到远程对等点(需深度研究)
    ```shell
    $ ipfs p2p listener ls
    Error: libp2p stream mounting not enabled
    // 需要修改config中Libp2pStreamMounting
    ```
- ipfs stats bw ---查看ipfs带宽
  ```shell
  $ ipfs stats bw
  Bandwidth
    TotalIn: 2.2 MB
    TotalOut: 3.4 MB
    RateIn: 13 kB/s
    RateOut: 20 kB/s
  ```
- [更多操作指令](https://docs.ipfs.io/reference/cli/)
## 5、安装gomobile-ipfs
开始项目前请先准备好以下插件
- [Java JDK](#54安装java-jdk) >= 1.8
- [Android SDK](#51安装android-sdk与android-ndk) >= 29
- [Android NDK]((#51安装android-sdk与android-ndk)) >= 23
- [Flutter](#53安装Flutter) >= 2.X
- [Go](#21go语言环境安装8) >= 1.16
- [gomobile](#52安装gomobile及gobind)
- [gobind](#52安装gomobile及gobind)
### 5.1、安装Android-SDK与Android-NDK
1. 下载安装android studio：https://developer.android.com/studio
   <font color=E3170D>启动Android Studio，选择是否导入AS设置，选择不导入，单击OK。</font>
   <font color=E3170D>显示未找到Android SDK，单击 Cancel 进入下一步。</font>
   
    **Windows**
    <div style="text-align: center">
        <img src="./images/studio-install-windows.gif"/>
    </div>

    **Mac**
    <div style="text-align: center">
        <img src="./images/studio-install-mac.gif"/>
    </div>
2. 打开Android Studio后打开偏好设置，或者使用快捷键`Ctrl + ,`下载SDK
    <div style="text-align: center">
        <img src="./images/22.png"/>
        <center style="font-size:12px;color:#666;text-decoration:underline;">点击Apply后下载SDK</center>
    </div>
3. 点击上一界面的SDK Tools下载NDK与CMake（CMake后期要使用）
   <div style="text-align: center">
        <img src="./images/23.png"/>
        <center style="font-size:12px;color:#666;text-decoration:underline;">点击Apply后下载NDK与CMake</center>
    </div>
4. 将Android SDK与NDK配置到系统环境变量
    - Windows
        首先，新建一个系统环境变量，变量名为ANDROID_SDK_HOME，变量值为你的SDK安装路径，例如G:\AndroidDevTools\android-sdk-windows，如图所示：（变量值后不加分号“;”）
        <div style="text-align: center">
            <img src="./images/24.png"/>
        </div>
        然后就是在系统的Path变量后，追加;% ANDROID_SDK_HOME%\platform-tools;% ANDROID_SDK_HOME%\tools，如图所示：（这里每个变量值后不需要加分号“;”系统会自动分隔每个变量值）
        <div style="text-align: center">
            <img src="./images/25.png"/>
        </div>
    - Mac
    在终端输入`vi ~/.bash_profile`，在尾部输入
        ```shell
        export ANDROID_HOME=SDK路径/Android/sdk
        export ANDROID_NDK_HOME=NDK路径/Android/sdk/ndk-bundle
        // 保存退出后使用命令更新配置文件
        source ~/.bash_profile
        ```
### 5.2、源码安装gomobile及gobind
1. 创建目录(<font color=E3170D>设置好GOPATH环境变量</font>)
   ```shell
   $ mkdir -r $GOPATH/src/golang.org/x/
   $ cd $GOPATH/src/golang.org/x/
   ```
2. 进入目录后下载代码
    ```git
    git clone https://github.com/golang/mobile.git
    git clone https://github.com/golang/mod.git
    git clone https://github.com/golang/xerrors.git
    git clone https://github.com/golang/tools.git
    git clone https://github.com/golang/sys.git
    ```
3. 运行如下命令
   ```shell
   $ go env -w GO111MODULE=auto
   // 生成gomobile，会生成在当前目录下，把该文件移动到$GOPATH/bin目录
   $ go build golang.org/x/mobile/cmd/gomobile
   $ cd $GOPATH/bin
   // 生成gobind
   $ gomobile init

   //测试一下
   $ gomobile version                           
   gomobile version +8a0a1e5 Thu Feb 24 13:45:51 2022 +0000 (android); androidSDK=/Users/xiaotijun/Library/Android/sdk/platforms/android-32
   ```
### 5.3、安装Flutter
1. 源码下载地址，下载2.x以上版本即可：https://github.com/flutter/flutter/tags
2. 解压安装包到你想安装的目录，如：
   ``` shell
   cd ~/Downloads
   unzip ~/Downloads/flutter-2.10.3.zip
   ```
3. 在`~/.bash_profile`环境变量中加入
   ```shell
   $ vim ~/.bash_profile
   // 在尾部加入flutter
   export ~/Downloads/flutter-2.10.3/bin
   // 保存退出后更新
   source ~/.bash_profilee
   ```
### 5.4、安装Java JDK
JAVA JDK安装不多赘述参考资料[^10]
### 5.5、启动gomobile-ipfs
项目地址：https://github.com/ipfs-shipyard/gomobile-ipfs
该项目是移动端ipfs节点创建项目，使用flutter编写，我们的项目是基于此项目来开发测试。项目下载后先不要使用IDE工具打开，先编译好项目需要使用到的go开发底层：
```shell
git clone https://github.com/ipfs-shipyard/gomobile-ipfs.git

cd gomobile-ipfs/packages

make build_core.android
```
<div style="text-align: center">
    <img src="./images/27.png"/>
    <center style="font-size:12px;color:#666;text-decoration:underline;">make命令展示</center>
</div>

<div style="text-align: center">
    <img src="./images/28.png"/>
    <center style="font-size:12px;color:#666;text-decoration:underline;">出现这个说明编译完成</center>
</div>

完成后使用Android Studio打开gomobile-ipfs/android项目，会自动下载Gradle进行项目依赖下载然后启动项目运行即可。
## 6、结语
IPFS技术自2014年诞生以来，引入无数人的关注，去中心化的概念，filecoin的激励支撑，以及区块链的加持使得ipfs越发的引入注目。ipfs协议构建了一种更安全、更有效、更经济的分布式数据存储架构。与传统网络协议Http相对应， ipfs是新一代的互联网底层协议，它吸引了很多互联网企业，包括微软、亚马逊、阿里、腾讯等，ipfs之所以成为能够吸引这些企业，是因为ipfs有着自己强大的应用价值和发展潜力。当我们还在对ipfs项目产生质疑，对它的未来发展前景担忧时，这些互联网巨头已经纷纷布局应用ipfs数据存储、ipfs生态应用和技术研发，他们默默在区块链市场抢占生机、大展身手。通过实际行动证明，ipfs分布式存储的未来，势不可挡。

## 7、ipfs参考外链
- [ipfs论坛](https://discuss.ipfs.io)
- [ipfs-API文档](https://docs.ipfs.io/reference/http/api/)
- [ipfs-测试项目----ipfs分支为android项目，example分之为java-client项目](https://github.com/ScienceNoBorders/ipfs-mobile-cunw.git)


**[⬆ Back to Index](#目录)**


[^1]: https://en.wikipedia.org/wiki/InterPlanetary_File_System
[^2]: https://github.com/xipfs/IPFS-Internals
[^3]: https://filecoin.io/​
[^4]: http://libp2p.io/​
[^5]: http://ipld.io/​
[^6]: http://multiformats.io/​
[^7]: https://www.wandouip.com/t5i122971/
[^8]: https://www.runoob.com/go/go-environment.html
[^9]: https://ipfs.netlify.app/docs/install.html
[^10]: https://www.runoob.com/java/java-environment-setup.html