const { Telegraf } = require("telegraf")
const { message } = require("telegraf/filters")
const ethers = require("ethers")

const fs = require("fs")
const path = require("path")
const axios = require('axios')
const { Worker } = require('worker_threads')
const util = require('util');
const exec = util.promisify(require('child_process').exec);

const dotenv = require("dotenv")
dotenv.config()

const BOT_NAME = 'Snow Laucher Bot'

const TokenAbi = require("./resources/TokenAbi.json")
const CrossChainBridgeAbi = require("./resources/CrossChainBridge.json")

const MINIMUM_ETH_LP = 0.01
const TESTNET_SHOW = process.env.TESTNET_SHOW == 1 ? true : false

const INSERT_ENDPOINT = "http://localhost:3001/create_new_transfer"

const SUPPORTED_CHAINS = [
    // {
    //     id: 31337, name: 'Localnet', rpc: 'http://127.0.0.1:8545', symbol: 'ETH', router: '0xFd0c6D2899Eb342b9E48abB3f21730e9F4532976', limit: 0.0001, apiKey: process.env.ETH_APIKEY, verifyApiUrl: "https://api.etherscan.io/api"
    // },
    {
        id: 43113,
        name: 'Avalanche Testnet',
        rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
        symbol: 'AVAX',
        limit: 0.01,
        scanUrl: "https://testnet.snowtrace.io",
        testnet: true,
        crossChainBridge: "0x765ccE4Cfb17Ee02F21Ece640eDf72Da4e00a445",
        chainSelector: "14767482510784806043",
        availableTokens: [
            {
                name: "AVAX",
                address: "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
                decimals: 18,
                isNative: true
            },
            {
                name: "USDC",
                address: "0x5425890298aed601595a70AB815c96711a31Bc65",
                decimals: 6
            }
        ]
    },
    {
        id: 43114,
        name: 'Avalanche Mainnet',
        hardhatChainname: "avalanche",
        rpc: 'https://api.avax.network/ext/bc/C/rpc',
        symbol: 'AVAX',
        router: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4', // TraderJoe
        limit: 2,
        scanUrl: "https://snowtrace.io/",
        testnet: false,
        availableTokens: [
            {
                name: "AVAX",
                address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
                decimals: 18
            },
            {
                name: "USDC",
                address: "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664",
                decimals: 6
            }
        ]
    },
    {
        id: 84531,
        name: 'Base Goerli',
        rpc: 'https://goerli.base.org',
        symbol: 'ETH',
        crossChainBridge: "0x0C8F4cEFacD0CBdd62F6E3E3aB6AAbDAFE1bD3dC",
        chainSelector: "5790810961207155433",
        limit: 0.5,
        scanUrl: "https://goerli.basescan.org",
        testnet: true,
        availableTokens: [
            {
                name: "ETH",
                address: "0x4200000000000000000000000000000000000006",
                decimals: 18,
                isNative: true
            },
            {
                name: "USDC",
                address: "0xf175520c52418dfe19c8098071a252da48cd1c19",
                decimals: 6
            }
        ]
    },
]


const INPUT_CAPTIONS = {
    pvkey: 'Please paste or enter private key of deployer wallet',
    amount: 'Please enter amount of tokens to transfer',
    receiverAddress: 'Please enter receiver address',
}

const { escape_markdown } = require("./common/utils")
const { error } = require("console")
const { parseEther, formatUnits, parseUnits } = require("ethers/lib/utils")
const createBot = () => {
    const token = process.env.BOT_TOKEN
    if (process.env.BOT_PROXY) {
        const [host, port] = process.env.BOT_PROXY.split(':')
        const HttpsProxyAgent = require('https-proxy-agent')
        const agent = new HttpsProxyAgent({ host, port })
        return new Telegraf(token, {
            telegram: { agent },
            handlerTimeout: 9_000_000
        })
    }
    return new Telegraf(token, {
        handlerTimeout: 9_000_000
    })
}

const bot = createBot()

bot.use(async (ctx, next) => {
    const t = Date.now()
    const res = await next()
    console.log(ctx.match?.input, Date.now() - t)
    return res
})

const states = {}
const tradings = {}

const state = (ctx, values) => {
    if (!values) {
        const defaultChain = SUPPORTED_CHAINS.find(chain => TESTNET_SHOW ? true : !chain.testnet)
        return {
            chainId: defaultChain.id,
            sourceChainId: 43113,
            destinationChainId: 84531,
            transfer: {
                status: "Not started",
                destinationChain: SUPPORTED_CHAINS[0].name,
                sourceChain: SUPPORTED_CHAINS[2].name,
            },
            ...(
                process.env.DEBUG_PVKEY ? {
                    pvkey: process.env.DEBUG_PVKEY,
                    account: new ethers.Wallet(process.env.DEBUG_PVKEY).address
                } : {}
            ),
            ...states[ctx.chat.id]
        }
    }
    states[ctx.chat.id] = {
        ...(states[ctx.chat.id] ?? {}), ...values
    }
}

const transfers = (ctx, transfer, update = false) => {
    const filepath = path.resolve(`./data/transfer-${ctx.chat.id}.json`)
    const data = fs.existsSync(filepath) ? JSON.parse(fs.readFileSync(filepath)) : []
    const { chainId, account } = state(ctx)
    if (!transfer)
        return data.filter(tx => tx.from == account)
    if (update)
        fs.writeFileSync(filepath, JSON.stringify(data.map(t => t.chain == chainId && t.address == transfer.address ? { ...t, ...transfer } : t)))
    else
        fs.writeFileSync(filepath, JSON.stringify([...data, transfer]))
}

const create = (ctx, caption, buttons) => {
    if (!ctx)
        return
    return ctx.telegram.sendMessage(ctx.chat.id, escape_markdown(caption), {
        parse_mode: "MarkdownV2",
        reply_markup: {
            inline_keyboard: buttons
        }
    }).catch(ex => { console.log(ex) })
}

const update = async (ctx, caption, buttons = [], must = false) => {
    if (!ctx)
        return

    if (must == true) {
        return await ctx.telegram.sendMessage(ctx.chat.id, escape_markdown(caption), {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: buttons
            }
        }).catch(ex => { console.log(ex) })
    }
    else if (ctx.update?.callback_query) {
        const msg = ctx.update.callback_query.message
        return await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, msg.message_id, escape_markdown(caption), {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: buttons
            }
        }).catch(ex => { console.log(ex) })
    } else if (ctx.message_id) {
        return await ctx.telegram.editMessageText(ctx.chat.id, ctx.message_id, ctx.message_id, escape_markdown(caption), {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: buttons
            }
        }).catch(ex => { console.log(ex) })
    } else {
        return await ctx.telegram.sendMessage(ctx.chat.id, escape_markdown(caption), {
            parse_mode: "MarkdownV2",
            reply_markup: {
                inline_keyboard: buttons
            }
        }).catch(ex => { console.log(ex) })
    }
}

const aggrAddress = (address) => `${address.substring(0, 10)}...${address.substring(38)}`

const showWelcome = async (ctx) => {
    const { chainId, pvkey } = state(ctx)
    return update(ctx, `Welcome to ${BOT_NAME}!`, [
        [
            {
                text: `Deploy`,
                callback_data: `back@deploy`,
            }
        ]
    ])
}


const showStart = async (ctx) => {
    const { sourceChainId, destinationChainId, pvkey } = state(ctx)
    if (pvkey)
        //return showWallet(ctx)
        return showWallet(ctx)

    return update(ctx, `Setup your wallet to start using ${BOT_NAME}!`, [
        [
            {
                text: `Connect Wallet`,
                callback_data: `back@account`,
            }
        ]
    ])
}

const showAccount = (ctx) => {
    const { pvkey } = state(ctx)
    update(ctx, 'Setup your Account', [
        pvkey ? [
            {
                text: `🔌 Disconnect`,
                callback_data: `disconnect`,
            }
        ] : [],
        [
            {
                text: `🔐 Existing private Key`,
                callback_data: `existing`,
            },
            {
                text: `🔑 Generate private Key`,
                callback_data: `generate`,
            }
        ],
        [
            {
                text: `🔙 Back`,
                callback_data: `back@start`,
            }
        ]
    ])
}

const showWallet = async (ctx) => {
    const { chainId, pvkey } = state(ctx)
    if (!pvkey)
        return showStart(ctx)
    const wallet = new ethers.Wallet(pvkey)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const balance = await provider.getBalance(wallet.address)


    return update(ctx, ['Main menu'].join('\n'), [
        [
            {
                text: `📝 New Transfer`,
                callback_data: `back@newtransfer`,
            },
            {
                text: `📋 Transaction history`,
                callback_data: `back@list`,
            }
        ],
        [
            {
                text: `🛠️ Settings`,
                callback_data: `back@account`,
            }
        ],
        [
            {
                text: `🔌 Disconnect`,
                callback_data: `disconnect`,
            }
        ]
    ])
}

const showWait = async (ctx, caption) => {
    return update(ctx, `⌛ ${caption}`)
}

const showPage = (ctx, page) => {
    if (page == 'start')
        showStart(ctx)
    else if (page == 'account')
        showAccount(ctx)
    else if (page == 'key')
        showAccount(ctx)
    else if (page == 'wallet')
        showWallet(ctx)
    else if (page == 'newtransfer')
        showNewTransfer(ctx)
    else if (page == 'list')
        showList(ctx)
    else if (/^token@(?<address>0x[\da-f]{40})$/i.test(page)) {
        const match = /^token@(?<address>0x[\da-f]{40})$/i.exec(page)
        if (match && match.groups.address)
            showToken(ctx, match.groups.address)
    } else if (/^bridge@(?<bridgeId>.+)$/.test(page)) {
        const match = /^bridge@(?<bridgeId>.+)$/i.exec(page)
        if (match && match.groups.bridgeId)
            showBridge(ctx, match.groups.bridgeId)
    } else
        showWelcome(ctx)
}

const showError = async (ctx, error, href, duration = 10000) => {
    // showPage(ctx, href)
    const err = await create(ctx, `⚠ ${error}`)
    if (duration)
        setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, err.message_id).catch(ex => { }), duration)
}

const showSuccess = async (ctx, message, href, duration = 10000) => {
    if (duration) setTimeout(() => showPage(ctx, href), duration)
    return update(ctx, `${message}`, [
        [
            {
                text: '🔙 Back',
                callback_data: `back@${href}`
            }
        ]
    ])
}

function makeid(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
        counter += 1;
    }
    return result;
}

const showList = async (ctx) => {
    const { chainId, pvkey } = state(ctx)

    if (!pvkey)
        return showAccount(ctx)
    const wallet = new ethers.Wallet(pvkey)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const balance = await provider.getBalance(wallet.address)
    const txs = transfers(ctx)
    console.log(txs)

    if (txs.length === 0) {
        return showError(ctx, `No transfers found!`)
    }

    return update(ctx, [`🔑 Address: "${wallet.address}"`, `📈 ${chain.symbol} balance: "${ethers.utils.formatEther(balance)}" Ξ`].join('\n'), [
        TESTNET_SHOW ? SUPPORTED_CHAINS.filter(chain => chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })) : [],
        SUPPORTED_CHAINS.filter(chain => !chain.testnet).map(chain => ({
            text: `${chain.id == chainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `chain@${chain.id}`
        })),
        ...txs.map(tx =>
            [
                {
                    text: `${tx.tokenName} (${tx.amount})`,
                    callback_data: `token@${tx.id}`
                }
            ]),
        [
            {
                text: `🔙 Back`,
                callback_data: `back@wallet`,
            }
        ]
    ])

}

const showNewTransfer = async (ctx) => {
    const { pvkey, transfer, sourceChainId, destinationChainId } = state(ctx)
    if (!pvkey)
        return showStart(ctx)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == sourceChainId)

    const wallet = new ethers.Wallet(pvkey)
    const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
    const balance = await provider.getBalance(wallet.address)

    /*
        SUPPORTED_CHAINS.filter(chain => !chain.testnet).map(chain => ({
            text: `${chain.id == destinationChainId ? '🟢' : '⚪'} Destination ${chain.name}`, callback_data: `destinationchain@${chain.id}`
        })),
        SUPPORTED_CHAINS.filter(chain => !chain.testnet).map(chain => ({
            text: `${chain.id == destinationChainId ? '🟢' : '⚪'} Destination ${chain.name}`, callback_data: `destinationchain@${chain.id}`
        })),

              TESTNET_SHOW ? SUPPORTED_CHAINS.filter(chain => chain.testnet).map(chain => ({
            text: `${chain.id == sourceChainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `sourcechain@${chain.id}`
        })) : [],
        TESTNET_SHOW ? SUPPORTED_CHAINS.filter(chain => chain.testnet).map(chain => ({
            text: `${chain.id == destinationChainId ? '🟢' : '⚪'} ${chain.name}`, callback_data: `destinationchain@${chain.id}`
        })) : [],
    */

    return update(ctx, [
        `🔑 Address: "${wallet.address}"`, `📈 ${chain.symbol} balance: "${ethers.utils.formatEther(balance)}" Ξ`,
        ' ',
        '🧳 Transfer',
        '',
        `${transfer.sourceChain ? '✅' : '❌'} Source Chain: "${transfer.sourceChain ?? 'Not set'}"`,
        `${transfer.destinationChain ? '✅' : '❌'} Destination Chain: "${transfer.destinationChain ?? 'Not set'}"`,
        `${transfer.tokenName ? '✅' : '❌'} Token: "${transfer.tokenName ?? 'Not set'}"`,
        `${transfer.amount ? '✅' : '❌'} Amount: "${transfer.amount ?? 'Not set'}"`,
        `${transfer.receiverAddress ? '✅' : '❌'} Receiver: "${transfer.receiverAddress ?? 'Not set'}"`,
        `Status: "${transfer.status}"`,

    ].join('\n'), [
        [{
            text: `Source      <--------------->      Destination`,
            callback_data: `a`,
        }],
        [
            {
                text: `${SUPPORTED_CHAINS[0].id == sourceChainId ? '🟢' : '⚪'} ${SUPPORTED_CHAINS[0].name}`, callback_data: `sourcechain@${SUPPORTED_CHAINS[0].id}`
            },
            {
                text: `${SUPPORTED_CHAINS[2].id == destinationChainId ? '🟢' : '⚪'} ${SUPPORTED_CHAINS[2].name}`, callback_data: `destinationchain@${SUPPORTED_CHAINS[2].id}`
            }
        ],
        [
            {
                text: `${SUPPORTED_CHAINS[2].id == sourceChainId ? '🟢' : '⚪'} ${SUPPORTED_CHAINS[2].name}`, callback_data: `sourcechain@${SUPPORTED_CHAINS[2].id}`
            },
            {
                text: `${SUPPORTED_CHAINS[0].id == destinationChainId ? '🟢' : '⚪'} ${SUPPORTED_CHAINS[0].name}`, callback_data: `destinationchain@${SUPPORTED_CHAINS[0].id}`
            }
        ],
        [{
            text: `------------      Token      ------------`,
            callback_data: `b`,
        }],
        chain.availableTokens.map(token => ({
            text: `${token.address === transfer.tokenAddress ? '🟢' : '⚪'} ${token.name}`, callback_data: `sourcetoken@${token.address}`
        })),
        [
            {
                text: `💲 Amount`,
                callback_data: `input@amount`,
            },
            {
                text: `💲 Receiver`,
                callback_data: `input@receiverAddress`,
            },
        ],
        [
            {
                text: `📝 Start Mix`,
                callback_data: `confirm@mix`,
            }
        ],
        [
            {
                text: `🔙 Back`,
                callback_data: `back@wallet`,
            }
        ],
        Object.keys(transfer).length ? [
            {
                text: `🔄 Restart`,
                callback_data: `reset`,
            }
        ] : []
    ])

}

bot.start(async (ctx) => {
    //showWelcome(ctx)
    showWallet(ctx)
})

bot.catch((err, ctx) => {
    try {
        ctx.reply(err.message, { reply_to_message_id: ctx.message?.message_id })
    } catch (ex) {
        console.log(ex)
        ctx.sendMessage(err.message)
    }
})

bot.command('settings', ctx => {
    showAccount(ctx)
})

bot.command('deploy', ctx => {
    showNewTransfer(ctx)
})

bot.action('disconnect', (ctx) => {
    state(ctx, { pvkey: undefined })
    showStart(ctx)
})

bot.action(/^confirm@(?<action>\w+)(#(?<params>.+))?$/, async (ctx) => {
    const { action, params } = ctx.match.groups
    const mid = ctx.update.callback_query.message.message_id
    console.log({ action, params, mid })
    const config = {
        deploy: {
            precheck: async (ctx) => {
                const { token, chainId } = state(ctx)
                if (!token.symbol)
                    throw new Error('You have to input symbol')
                if (!token.name)
                    throw new Error('You have to input name')
                if (!token.supply)
                    throw new Error('You have to specify supply')
                const chain = SUPPORTED_CHAINS.find(chain => chain.id == chainId)
                //const provider = new ethers.providers.JsonRpcProvider(chain.rpc)

                if (chainId !== 999999999) {
                    if (!token.ethLP) {
                        throw new Error(`You have to specify ${chain.symbol} LP`)
                    }
                }


            },
            caption: 'Would you like to deploy contract?',
            back: 'back@deploy',
            proceed: `deploy#${mid}`
        },
        mix: {
            precheck: (ctx) => {
            },
            caption: 'Would you like to mix?',
            back: 'back@welcome',
            proceed: `mix#${mid}`
        },

    }[action]
    try {
        await config.precheck?.(ctx)
        create(ctx, [`⚠️ ${config.caption} ⚠️`, ...(config.prompt ? [config.prompt] : [])].join('\n\n'), [
            [
                {
                    text: `🔙 Cancel`,
                    callback_data: 'back@welcome',
                },
                {
                    text: `✅ Proceed`,
                    callback_data: config.proceed
                }
            ]
        ])
    } catch (ex) {
        const err = await ctx.sendMessage(`⚠️ ${ex.message}`)
        setTimeout(() => ctx.telegram.deleteMessage(err.chat.id, err.message_id).catch(ex => { }), 1000)
    }
})

bot.action(/^mix(#(?<mid>\d+))?$/, async (ctx) => {
    if (!ctx.match) {
        return
    }

    await showWait(ctx, 'Mixing...');

    const { pvkey, transfer, sourceChainId, destinationChainId } = state(ctx)
    const sourceChain = SUPPORTED_CHAINS.find(chain => chain.id == sourceChainId)
    const destinationChain = SUPPORTED_CHAINS.find(chain => chain.id == destinationChainId)
    console.log({ s: sourceChain.chainSelector, d: destinationChain.chainSelector })
    const sourceToken = sourceChain.availableTokens.find(token => token.address.toLowerCase() == transfer.tokenAddress.toLowerCase())


    const provider = new ethers.providers.JsonRpcProvider(sourceChain.rpc)
    const wallet = new ethers.Wallet(pvkey, provider)
    const crossChainBridge = new ethers.Contract(sourceChain.crossChainBridge, CrossChainBridgeAbi, wallet)

    if (sourceToken.isNative) {
        const tx = await (await crossChainBridge.sendNativeMessage(destinationChain.chainSelector.toString(), destinationChain.crossChainBridge, "Send", { value: parseUnits(transfer.amount.toString(), sourceToken.decimals) })).wait()

        console.log({
            tx: tx
        })

        const MessageSentLog = tx.logs.find((log) => {
            try {
                return crossChainBridge.interface.parseLog(log).name === "MessageSent"
            } catch (e) {
            }
        })
        const parsedLog = crossChainBridge.interface.parseLog(MessageSentLog)
        console.log({
            parsedLog: parsedLog
        })
        const { messageId, tokenAmount, token } = parsedLog.args

        const body = {
            tg_id: ctx.chat.id,
            from: wallet.address,
            to: transfer.receiverAddress,
            source_chain: sourceChainId,
            destination_chain: destinationChainId,
            source_chain_tx_hash: tx.transactionHash,
            destination_chain_tx_hash: " ",
            message_id: messageId,
            tokenAddress: sourceToken.address,
            tokenName: sourceToken.name,
            amount: tokenAmount.toString(),
            usdc_amount: tokenAmount.toString(),
            status: "pending",
        }

        const res = await axios.post(INSERT_ENDPOINT, body)
        console.log(res.data)

        transfers(ctx, { ...transfer, status: "Sent", txHash: tx.hash, from: wallet.address, chain: sourceChainId, id: makeid(10) })

    } else {
        const tokenContract = new ethers.Contract(transfer.tokenAddress, TokenAbi, wallet)
        await (await tokenContract.approve(sourceChain.crossChainBridge, parseUnits(transfer.amount.toString(), sourceToken.decimals))).wait()
        const tx = await (await crossChainBridge.sendTokenMessage(destinationChain.chainSelector.toString(), destinationChain.crossChainBridge, "Send", transfer.tokenAddress, parseUnits(transfer.amount.toString(), sourceToken.decimals))).wait()

        console.log({
            tx: tx
        })


        const MessageSentLog = tx.logs.find((log) => {
            try {
                return crossChainBridge.interface.parseLog(log).name === "MessageSent"
            } catch (e) {
            }
        })
        const parsedLog = crossChainBridge.interface.parseLog(MessageSentLog)
        console.log({
            parsedLog: parsedLog
        })
        const { messageId, tokenAmount, token } = parsedLog.args


        const body = {
            tg_id: ctx.chat.id,
            from: wallet.address,
            to: transfer.receiverAddress,
            source_chain: sourceChainId,
            destination_chain: destinationChainId,
            source_chain_tx_hash: tx.transactionHash,
            destination_chain_tx_hash: " ",
            message_id: messageId,
            tokenAddress: sourceToken.address,
            tokenName: sourceToken.name,
            amount: tokenAmount.toString(),
            usdc_amount: tokenAmount.toString(),
            status: "pending",
        }

        const res = await axios.post(INSERT_ENDPOINT, body)
        console.log(res.data)

        transfers(ctx, { ...transfer, status: "Sent", txHash: tx.hash, from: wallet.address, chain: sourceChainId, id: makeid(10) })
    }

    state(ctx, {
        transfer: {
            status: "Not started",
            destinationChain: SUPPORTED_CHAINS[0].name,
            sourceChain: SUPPORTED_CHAINS[2].name,
        }
    })
    showNewTransfer(ctx)
})

bot.action('reset', (ctx) => {
    state(ctx, { token: {} })
    showNewTransfer(ctx)
})

bot.action('close', ctx => {
    ctx.telegram.deleteMessage(ctx.chat.id, ctx.update.callback_query.message.message_id).catch(ex => { })
})

bot.action(/^sourcetoken@(?<address>0x[\da-f]{40})$/i, (ctx) => {
    const tokenAddress = ctx.match.groups.address;
    console.log({ tokenAddress })
    const { pvkey, transfer, sourceChainId } = state(ctx)
    if (!pvkey)
        return showStart(ctx)
    const chain = SUPPORTED_CHAINS.find(chain => chain.id == sourceChainId)
    const tokenName = chain.availableTokens.find(token => token.address == tokenAddress)?.name
    state(ctx, { transfer: { ...transfer, tokenAddress: tokenAddress, tokenName: tokenName } })
    if (ctx.match && ctx.match.groups.page) {
        const page = ctx.match.groups.page
        showPage(ctx, page)
    } else
        showNewTransfer(ctx)
})


bot.action('existing', async (ctx) => {
    update(ctx, '⚠️ WARNING: Set a new private Key? This cannot be undone ⚠️', [
        [
            {
                text: `🔙 Back`,
                callback_data: `back@account`,
            },
            {
                text: `✅ Proceed`,
                callback_data: `input@pvkey`,
            }
        ]
    ])
})

bot.action('generate', (ctx) => {
    update(ctx, '⚠️ WARNING: Generate a new private Key? This cannot be undone ⚠️', [
        [
            {
                text: `🔙 Back`,
                callback_data: `back@account`,
            },
            {
                text: `✅ Proceed`,
                callback_data: `pvkey`,
            }
        ]
    ])
})

bot.action('pvkey', async (ctx) => {
    const wallet = new ethers.Wallet.createRandom()
    state(ctx, { pvkey: wallet.privateKey, account: wallet.address })
    showSuccess(ctx, `Account generated!\n\nPrivate key is "${wallet.privateKey}"\nAddress is "${wallet.address}"`, 'account', 0)
})

bot.action(/^sourcechain@(?<chain>\d+)(#(?<page>\w+))?$/, (ctx) => {
    if (!ctx.match || !ctx.match.groups.chain) {
        throw Error("You didn't specify chain.")
    }
    const chain = SUPPORTED_CHAINS.find(chain => Number(ctx.match.groups.chain) == chain.id)
    if (!chain)
        throw Error("You selected wrong chain.")
    const { transfer } = state(ctx)

    state(ctx, { sourceChainId: chain.id })
    state(ctx, { transfer: { ...transfer, sourceChain: chain.name } })
    if (ctx.match && ctx.match.groups.page) {
        const page = ctx.match.groups.page
        showPage(ctx, page)
    } else
        showNewTransfer(ctx)
})

bot.action(/^destinationchain@(?<chain>\d+)(#(?<page>\w+))?$/, (ctx) => {
    if (!ctx.match || !ctx.match.groups.chain) {
        throw Error("You didn't specify chain.")
    }
    const chain = SUPPORTED_CHAINS.find(chain => Number(ctx.match.groups.chain) == chain.id)
    if (!chain)
        throw Error("You selected wrong chain.")
    const { transfer } = state(ctx)
    state(ctx, { destinationChainId: chain.id })
    state(ctx, { transfer: { ...transfer, destinationChain: chain.name } })
    if (ctx.match && ctx.match.groups.page) {
        const page = ctx.match.groups.page
        showPage(ctx, page)
    } else
        showNewTransfer(ctx)
})

bot.action(/^back@(?<page>\w+)$/, (ctx) => {
    if (!ctx.match) {
        throw Error("You didn't specify chain.")
    }
    const page = ctx.match.groups.page
    showPage(ctx, page)
})

bot.action(/^input@(?<name>\w+)(#((?<address>0x[\da-fA-F]{40})|(?<id>.+)))?$/, async (ctx) => {
    if (!ctx.match) {
        return
    }
    const { name, address, id } = ctx.match.groups
    const caption = INPUT_CAPTIONS[name]
    if (!caption)
        return
    const { inputMessage } = state(ctx)
    console.log({ inputMessage })
    if (inputMessage) {
        bot.telegram.deleteMessage(ctx.chat.id, inputMessage.message_id).catch(ex => { })
    }
    const msg = await create(ctx, caption)
    let inputBack = 'newtransfer'
    if (name == 'bridgeAmount')
        inputBack = 'bridges'
    else if (name == 'bridgeTo')
        inputBack = `bridge@${id}`
    else if (address)
        inputBack = `token@${address}`


    state(ctx, {
        inputMode: name, inputMessage: msg, context: ctx, inputBack
    })
})

bot.on(message('text'), async (ctx) => {
    const { inputMode, inputMessage, context, inputBack, pvkey, sourceChainId } = state(ctx)
    if (context) {
        const text = ctx.update.message.text.trim()
        try {
            if (inputMode == 'pvkey' && !/^(0x)?[\da-f]{64}$/.test(text)) {
                throw Error('Invalid private key format!')
            } else if (inputMode == 'amount') {
                if (isNaN(Number(text)) || Number(text) == 0)
                    throw Error('Invalid amount format!')
                const { transfer, sourceChainId } = state(ctx)

                const wallet = new ethers.Wallet(pvkey)
                const chain = SUPPORTED_CHAINS.find(chain => chain.id == sourceChainId)
                const provider = new ethers.providers.JsonRpcProvider(chain.rpc)
                const balance = await provider.getBalance(wallet.address)
                state(ctx, { transfer: { ...transfer, amount: Number(text) } })
            } else if (inputMode == 'receiverAddress') {
                if (!/^(0x)?[\da-f]{40}$/i.test(text))
                    throw Error('Invalid address format!')
                const { transfer } = state(ctx)
                state(ctx, { transfer: { ...transfer, receiverAddress: text } })
            }

            if (inputMode == 'pvkey') {
                const wallet = new ethers.Wallet(text)
                state(ctx, { pvkey: wallet.privateKey, account: wallet.address })
                await showSuccess(context, `Account imported!\n\nPrivate key is "${wallet.privateKey}", address is "${wallet.address}"`, 'account', 0)
            } else if (inputBack) {
                showPage(context, inputBack)
            }
        } catch (ex) {
            console.log(ex)
            await showError(ctx, ex.message, inputBack)
        }

        if (inputMode != "mixerAmount" && inputMode != "mixerReceiverAddress") {
            try {
                bot.telegram.deleteMessage(ctx.chat.id, ctx.update.message.message_id).catch(ex => { });
                bot.telegram.deleteMessage(ctx.chat.id, inputMessage.message_id).catch(ex => { });
            } catch (ex) {
                console.log(ex);
            }
        }
    }
})

bot.launch()

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))