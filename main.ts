import { config as dotenv } from "dotenv";
import {
  createWalletClient,
  http,
  getContract,
  erc20Abi,
  parseUnits,
  maxUint256,
  publicActions,
  concat,
  numberToHex,
  size,
} from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { usdcAbi } from "./abi/usdc-abi";

dotenv();
const { PRIVATE_KEY, ZERO_EX_API_KEY, ALCHEMY_HTTP_TRANSPORT_URL } =
  process.env;

if (!PRIVATE_KEY) throw new Error("missing PRIVATE_KEY.");
if (!ZERO_EX_API_KEY) throw new Error("missing ZERO_EX_API_KEY.");
if (!ALCHEMY_HTTP_TRANSPORT_URL)
  throw new Error("missing ALCHEMY_HTTP_TRANSPORT_URL.");

const headers = new Headers({
  "Content-Type": "application/json",
  "0x-api-key": ZERO_EX_API_KEY,
  "0x-version": "v2",
});

const client = createWalletClient({
  account: privateKeyToAccount(`0x${PRIVATE_KEY}` as `0x${string}`),
  chain: base,
  transport: http(ALCHEMY_HTTP_TRANSPORT_URL),
}).extend(publicActions);

const [address] = await client.getAddresses();

const CONTRACTS = {
  ETH: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;

const eth = getContract({
  address: CONTRACTS.ETH,
  abi: erc20Abi,
  client,
});

const weth = getContract({
  address: CONTRACTS.WETH,
  abi: erc20Abi,
  client,
});

const usdc = getContract({
  address: CONTRACTS.USDC,
  abi: usdcAbi,
  client,
});

type TokenType = "ETH" | "WETH";

const executeSwap = async (sellTokenType: TokenType) => {
  const sellToken = sellTokenType === "ETH" ? eth : weth;
  let sellAmount;

  if (sellToken.address === CONTRACTS.ETH) {
    sellAmount = parseUnits("0.0001", 18); // ETH has 18 decimals
  } else {
    sellAmount = parseUnits("0.0001", await sellToken.read.decimals());
  }

  const priceParams = new URLSearchParams({
    chainId: client.chain.id.toString(),
    sellToken: sellToken.address,
    buyToken: CONTRACTS.USDC,
    sellAmount: sellAmount.toString(),
    taker: client.account.address,
  });

  const priceResponse = await fetch(
    "https://api.0x.org/swap/permit2/price?" + priceParams.toString(),
    { headers }
  );

  const price = await priceResponse.json();
  console.log(`Fetching price to swap 0.0001 ${sellTokenType} for USDC`);
  console.log(
    `https://api.0x.org/swap/permit2/price?${priceParams.toString()}`
  );
  console.log("priceResponse: ", price);

  if (sellToken.address === CONTRACTS.ETH) {
    console.log("Native token detected, no need for allowance check");
  } else {
    if (price.issues.allowance !== null) {
      try {
        const { request } = await sellToken.simulate.approve([
          price.issues.allowance.spender,
          maxUint256,
        ]);
        console.log("Approving Permit2 to spend sellToken...", request);

        const hash = await sellToken.write.approve(request.args);
        console.log(
          "Approved Permit2 to spend sellToken.",
          await client.waitForTransactionReceipt({ hash })
        );
      } catch (error) {
        console.log("Error approving Permit2:", error);
      }
    } else {
      console.log("sellToken already approved for Permit2");
    }
  }

  const quoteParams = new URLSearchParams();
  for (const [key, value] of priceParams.entries()) {
    quoteParams.append(key, value);
  }

  const quoteResponse = await fetch(
    "https://api.0x.org/swap/permit2/quote?" + quoteParams.toString(),
    { headers }
  );

  const quote = await quoteResponse.json();
  console.log(`Fetching quote to swap 0.0001 ${sellTokenType} for USDC`);
  console.log("quoteResponse: ", quote);

  let signature: Hex | undefined;
  if (quote.permit2?.eip712) {
    try {
      signature = await client.signTypedData(quote.permit2.eip712);
      console.log("Signed permit2 message from quote response");
    } catch (error) {
      console.error("Error signing permit2 coupon:", error);
    }

    if (signature && quote?.transaction?.data) {
      const signatureLengthInHex = numberToHex(size(signature), {
        signed: false,
        size: 32,
      });

      const transactionData = quote.transaction.data as Hex;
      const sigLengthHex = signatureLengthInHex as Hex;
      const sig = signature as Hex;

      quote.transaction.data = concat([transactionData, sigLengthHex, sig]);
    } else {
      throw new Error("Failed to obtain signature or transaction data");
    }
  }

  const nonce = await client.getTransactionCount({
    address: client.account.address,
  });

  if (sellToken.address === CONTRACTS.ETH) {
    const transaction = await client.sendTransaction({
      account: client.account,
      chain: client.chain,
      gas: !!quote?.transaction.gas
        ? BigInt(quote?.transaction.gas)
        : undefined,
      to: quote?.transaction.to,
      data: quote.transaction.data,
      value: BigInt(quote.transaction.value),
      gasPrice: !!quote?.transaction.gasPrice
        ? BigInt(quote?.transaction.gasPrice)
        : undefined,
      nonce: nonce,
    });

    console.log("Transaction hash:", transaction);
    console.log(`See tx details at https://basescan.org/tx/${transaction}`);
  } else if (signature && quote.transaction.data) {
    const signedTransaction = await client.signTransaction({
      account: client.account,
      chain: client.chain,
      gas: !!quote?.transaction.gas
        ? BigInt(quote?.transaction.gas)
        : undefined,
      to: quote?.transaction.to,
      data: quote.transaction.data,
      gasPrice: !!quote?.transaction.gasPrice
        ? BigInt(quote?.transaction.gasPrice)
        : undefined,
      nonce: nonce,
    });

    const hash = await client.sendRawTransaction({
      serializedTransaction: signedTransaction,
    });

    console.log("Transaction hash:", hash);
    console.log(`See tx details at https://basescan.org/tx/${hash}`);
  } else {
    console.error("Failed to obtain a signature, transaction not sent.");
  }
};

const main = async () => {
  try {
    console.log("Executing ETH to USDC swap...");
    await executeSwap("ETH");

    console.log("Waiting before executing next swap...");
    await new Promise((resolve) => setTimeout(resolve, 15000)); // Wait 15 seconds

    console.log("\nExecuting WETH to USDC swap...");
    await executeSwap("WETH");
  } catch (error) {
    console.error("Error executing swaps:", error);
  }
};

main();
