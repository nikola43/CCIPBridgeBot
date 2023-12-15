const express = require('express');
const cors = require('cors');
const dotenv = require("dotenv");
const bodyParser = require('body-parser')
const { Sequelize, DataTypes } = require("sequelize");
const e = require('express');
const app = express();
const port = 3001;
dotenv.config();

const sequelize = new Sequelize(
    'mixerdb',
    'root',
    '',
    {
        host: 'localhost',
        dialect: 'mysql'
    }
);

const Transfer = sequelize.define("transfers", {
    id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false
    },
    tg_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    from: {
        type: DataTypes.STRING,
        allowNull: false
    },
    to: {
        type: DataTypes.STRING,
        allowNull: false
    },
    source_chain: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    destination_chain: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    source_chain_tx_hash: {
        type: DataTypes.STRING,
        allowNull: false
    },
    destination_chain_tx_hash: {
        type: DataTypes.STRING,
        allowNull: true,
        defaultValue: ""
    },
    message_id: {
        type: DataTypes.STRING,
        allowNull: false
    },
    tokenAddress: {
        type: DataTypes.STRING,
        allowNull: false
    },
    tokenName: {
        type: DataTypes.STRING,
        allowNull: false
    },
    amount: {
        type: DataTypes.STRING,
        allowNull: false
    },
    usdc_amount: {
        type: DataTypes.STRING,
        allowNull: false
    },
    status: {
        type: DataTypes.STRING,
        allowNull: false
    }
});


sequelize.authenticate().then(() => {
    console.log('Connection has been established successfully.');
}).catch((error) => {
    console.error('Unable to connect to the database: ', error);
});




sequelize.sync().then(() => {
    console.log('Book table created successfully!');
}).catch((error) => {
    console.error('Unable to create table : ', error);
});



app.use(cors({
    //origin: 'https:website.com'
    origin: '*'
}));

app.use(bodyParser.json())

app.get('/', (req, res) => {
    res.send('Express Server');
});

// Get 
app.get('/transfers_by_wallet/:wallet', async (req, res) => {

    try {
        const wallet = req.params.wallet;
        if (!/^(0x)?[\da-f]{40}$/i.test(wallet))
            res.status(400).send({ error: 'invalid wallet address' });

        const transfers = await Transfer.findAll({
            where: {
                from: wallet
            }
        });

        res.send(transfers);
    } catch (error) {
        console.log(error);
        res.status(500).send({ error: error.message });
    }
});

app.get('/transfers_by_tg_id/:tg_id', async (req, res) => {
    try {
        const tg_id = req.params.tg_id;
        if (isNaN(Number(tg_id))) {
            res.status(400).send({ error: 'invalid tg_id' });
        }

        const transfers = await Transfer.findAll({
            where: {
                tg_id: Number(tg_id)
            }
        });

        res.send(transfers);
    } catch (error) {
        console.log(error);
        res.status(500).send({ error: error.message });
    }
});

app.post('/create_new_transfer', async (req, res) => {


    try {
        const body = req.body;
        console.log('body is ', body);

        const tx = await Transfer.findOne({
            where: {
                message_id: body.message_id
            }
        })

        if (tx) {
            res.status(400).send({ error: 'message_id already exists' });
            return;
        }

        const newTransfer = await Transfer.create({
            tg_id: body.tg_id,
            from: body.from,
            to: body.to,
            source_chain: body.source_chain,
            destination_chain: body.destination_chain,
            source_chain_tx_hash: body.source_chain_tx_hash,
            destination_chain_tx_hash: body.destination_chain_tx_hash,
            message_id: body.message_id,
            tokenAddress: body.tokenAddress,
            tokenName: body.tokenName,
            amount: body.amount,
            usdc_amount: body.usdc_amount,
            status: body.status,
            created_at: body.created_at,
        });

        console.log('newTransfer is ', newTransfer);
        res.send(req.body);
    } catch (error) {
        console.log(error);
        res.status(500).send({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})