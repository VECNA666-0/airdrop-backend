import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { ethers } from 'ethers';

// === НАСТРОЙКИ ===
const TOKEN    = (process.env.TOKEN || '0xaD6a4F5AF2dAddE7801EAbEa764A7D4cF0EF7Cb3').toLowerCase();
const CHAIN_ID = Number(process.env.CHAIN_ID || 137);      // Polygon
const AMOUNT   = BigInt(process.env.AMOUNT || 1000n);      // 1000 штук
const RPC_URL  = process.env.RPC_URL || 'https://polygon-rpc.com';
const CORS_ORIGINS = process.env.CORS_ORIGINS || '*';      // на тестах можно '*'
const PORT = process.env.PORT || 8787;

// === APP ===
const app = express();
app.use(cors({ origin: CORS_ORIGINS === '*' ? true : CORS_ORIGINS.split(',').map(s=>s.trim()) }));
app.use(express.json({ limit: '256kb' }));

// === WALLET С ТВОИМ PRIVATE_KEY (именно он платит газ) ===
const PK = (process.env.PRIVATE_KEY || '').trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(PK)) throw new Error('PRIVATE_KEY не задан или неверный (нужна строка 0x + 64 hex)');
const provider = new ethers.JsonRpcProvider(RPC_URL);
let wallet = new ethers.Wallet(PK, provider);

// === ERC20 ===
const erc20 = new ethers.Contract(
  TOKEN,
  [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function transfer(address,uint256) returns (bool)'
  ],
  wallet
);
const symbol = await erc20.symbol().catch(()=> 'TKN');
const decimals = await erc20.decimals().catch(()=> 18);
const amountWei = ethers.parseUnits(String(AMOUNT), decimals);

// === /health для пинга с фронта ===
app.get('/health', async (_req,res)=>{
  const addr = await wallet.getAddress().catch(()=> '');
  res.json({ ok:true, chainId: CHAIN_ID, token: TOKEN, sender: addr, symbol, decimals });
});

// === /api/claim: фронт шлёт подпись, сервер отправляет transfer() и платит газ ===
app.post('/api/claim', async (req,res)=>{
  try{
    const { token, claimer, amount, nonce, deadline, signature } = req.body || {};
    if ((token||'').toLowerCase() !== TOKEN) return res.status(400).json({ error:'Bad token' });
    if (!ethers.isAddress(claimer))         return res.status(400).json({ error:'Bad claimer' });
    if (String(amount) !== amountWei.toString()) return res.status(400).json({ error:'Bad amount' });
    if (Math.floor(Date.now()/1000) > Number(deadline)) return res.status(400).json({ error:'Expired' });

    // верифицируем подпись (EIP-712)
    const domainNames = ['NY Airdrop','VEN Airdrop','Airdrop','Claim'];
    const types = { Claim:[
      {name:'claimer',type:'address'},
      {name:'amount', type:'uint256'},
      {name:'nonce',  type:'uint256'},
      {name:'deadline',type:'uint256'}
    ]};
    const msg = { claimer, amount, nonce, deadline };
    let ok = false;
    for (const name of domainNames){
      try{
        const domain = { name, version:'1', chainId: CHAIN_ID };
        const rec = ethers.verifyTypedData(domain, types, msg, signature);
        if (rec.toLowerCase() === claimer.toLowerCase()) { ok = true; break; }
      }catch{}
    }
    if (!ok) return res.status(400).json({ error:'Bad signature' });

    // отправляем токены (ГАЗ ПЛАТИТ ЭТОТ WALLET)
    const tx = await erc20.transfer(claimer, amountWei);
    return res.json({ ok:true, txHash: tx.hash });
  }catch(e){
    return res.status(500).json({ error: e.shortMessage || e.message || 'Server error' });
  }
});

// === START ===
app.listen(PORT, async ()=>{
  const addr = await wallet.getAddress().catch(()=> '');
  console.log(`Airdrop server :${PORT}`);
  console.log(`Sender: ${addr}`);
  console.log(`Token: ${TOKEN} (${symbol}, ${decimals}d) amount: ${AMOUNT} -> ${amountWei}`);
});
