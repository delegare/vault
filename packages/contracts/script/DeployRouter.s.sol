// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {DelegareRouter} from "../src/DelegareRouter.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @notice Deploy DelegareRouter behind a UUPS proxy.
 *
 *   PRIVATE_KEY=0x...  TREASURY_ADDRESS=0x...  forge script script/DeployRouter.s.sol --rpc-url $RPC --broadcast
 *
 *   The deployer is set as initial treasury so it can whitelist tokens,
 *   then treasury ownership is transferred to the real treasury address.
 */
contract DeployRouter is Script {
    // Base Mainnet
    address constant USDC_MAINNET = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDT_MAINNET = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;

    // Base Sepolia
    address constant USDC_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        bool isTestnet = vm.envOr("TESTNET", false);

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy implementation
        DelegareRouter implementation = new DelegareRouter();
        console.log("Implementation deployed to:", address(implementation));

        // 2. Deploy proxy — initialize with deployer as treasury so we can whitelist tokens
        bytes memory initData = abi.encodeCall(DelegareRouter.initialize, (deployer));
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        console.log("Proxy (Router) deployed to:", address(proxy));

        DelegareRouter router = DelegareRouter(address(proxy));

        // 3. Whitelist stablecoins (deployer is treasury, so this succeeds)
        if (isTestnet) {
            router.addSupportedToken(USDC_SEPOLIA, 6);
            console.log("Whitelisted USDC (Sepolia):", USDC_SEPOLIA);
        } else {
            router.addSupportedToken(USDC_MAINNET, 6);
            router.addSupportedToken(USDT_MAINNET, 6);
            console.log("Whitelisted USDC (Mainnet):", USDC_MAINNET);
            console.log("Whitelisted USDT (Mainnet):", USDT_MAINNET);
        }

        // 4. Transfer treasury to the real address
        if (deployer != treasury) {
            router.setTreasury(treasury);
            console.log("Treasury transferred to:", treasury);
        } else {
            console.log("Deployer IS treasury:", treasury);
        }

        vm.stopBroadcast();
    }
}
