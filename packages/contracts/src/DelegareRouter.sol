// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/**
 * @title DelegareRouter (v1)
 * @author Delegare Labs
 * @notice Trustless payment router enabling AI agents (Session Keys) to spend stablecoins
 *         on behalf of a user's wallet, up to mathematically enforced on-chain limits.
 *
 * @dev Deployed behind an ERC1967 proxy (UUPS pattern) for upgradeability.
 *
 *      Session key allowances are denominated in token-native units and are shared across
 *      all supported tokens. This is by design — it enforces a total spend cap regardless
 *      of which stablecoin the agent uses. To prevent accounting mismatches, only tokens
 *      with the same `decimals` value can be registered (e.g. USDC-6 and USDT-6).
 */
contract DelegareRouter is Initializable, UUPSUpgradeable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── Storage (append-only for upgrade safety) ────────────────────────────

    address public treasury;

    /// @notice owner => sessionKey => remainingAllowance (token-native units, shared across tokens)
    mapping(address => mapping(address => uint256)) public sessionKeyAllowances;

    /// @notice Whitelisted tokens. Value is the token's `decimals` (1-255 = supported, 0 = not).
    mapping(address => uint8) public supportedTokenDecimals;

    /// @notice The canonical decimals all supported tokens must share (set on first token add).
    uint8 public canonicalDecimals;

    // ── Events ──────────────────────────────────────────────────────────────

    event SessionKeyAuthorized(
        address indexed owner,
        address indexed sessionKey,
        uint256 allowance
    );

    event SessionKeyRevoked(
        address indexed owner,
        address indexed sessionKey
    );

    event PaymentRouted(
        address indexed token,
        address indexed from,
        address indexed merchant,
        address sessionKey,
        uint256 amount,
        uint256 fee
    );

    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event TokenAdded(address indexed token, uint8 decimals);
    event TokenRemoved(address indexed token);

    // ── Errors ──────────────────────────────────────────────────────────────

    error InvalidAddress();
    error Unauthorized();
    error UnauthorizedSessionKey();
    error AllowanceExceeded(uint256 requested, uint256 available);
    error ZeroAmount();
    error UnsupportedToken(address token);
    error DecimalMismatch(uint8 expected, uint8 actual);

    // ── Initializer (replaces constructor for UUPS proxy) ───────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _treasury) public initializer {
        if (_treasury == address(0)) revert InvalidAddress();
        treasury = _treasury;
    }

    // ── Token whitelist ─────────────────────────────────────────────────────

    /**
     * @notice Register a stablecoin for use in payments.
     * @dev All supported tokens MUST share the same `decimals` value.
     *      The first token added sets the canonical decimals for the contract.
     */
    function addSupportedToken(address token, uint8 decimals) external {
        if (msg.sender != treasury) revert Unauthorized();
        if (token == address(0)) revert InvalidAddress();
        if (decimals == 0) revert ZeroAmount(); // 0 reserved for "not supported"

        if (canonicalDecimals == 0) {
            // First token sets the canonical decimals
            canonicalDecimals = decimals;
        } else if (decimals != canonicalDecimals) {
            revert DecimalMismatch(canonicalDecimals, decimals);
        }

        supportedTokenDecimals[token] = decimals;
        emit TokenAdded(token, decimals);
    }

    /**
     * @notice Remove a token from the whitelist.
     */
    function removeSupportedToken(address token) external {
        if (msg.sender != treasury) revert Unauthorized();
        supportedTokenDecimals[token] = 0;
        emit TokenRemoved(token);
    }

    // ── Session key management ──────────────────────────────────────────────

    /**
     * @notice Authorize a Session Key to spend tokens on your behalf.
     * @param sessionKey The ephemeral ECDSA public key held by the Delegare Vault
     * @param allowance  Total token-native units the key may spend (shared across all tokens)
     */
    function authorizeSessionKey(address sessionKey, uint256 allowance) external {
        if (sessionKey == address(0)) revert InvalidAddress();
        sessionKeyAllowances[msg.sender][sessionKey] = allowance;
        emit SessionKeyAuthorized(msg.sender, sessionKey, allowance);
    }

    /**
     * @notice Revoke a Session Key, instantly bricking the Vault's spending access.
     */
    function revokeSessionKey(address sessionKey) external {
        sessionKeyAllowances[msg.sender][sessionKey] = 0;
        emit SessionKeyRevoked(msg.sender, sessionKey);
    }

    // ── Payment routing ─────────────────────────────────────────────────────

    /**
     * @notice Route a delegated payment, enforcing on-chain session key limits.
     * @dev Follows Checks-Effects-Interactions (CEI) and is protected by ReentrancyGuard.
     * @param token    Whitelisted ERC-20 stablecoin address
     * @param from     User's wallet (where the funds live — must have approved this contract)
     * @param merchant Payment recipient
     * @param amount   Merchant payout in token-native units
     * @param fee      Platform fee in token-native units (sent to treasury)
     */
    function payMerchant(
        address token,
        address from,
        address merchant,
        uint256 amount,
        uint256 fee
    ) external nonReentrant whenNotPaused {
        if (merchant == address(0) || from == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        if (supportedTokenDecimals[token] == 0) revert UnsupportedToken(token);

        uint256 totalAmount = amount + fee; // Solidity 0.8 overflow check is implicit

        // ── Checks + Effects ────────────────────────────────────────────
        if (msg.sender != from) {
            uint256 currentAllowance = sessionKeyAllowances[from][msg.sender];
            if (currentAllowance == 0) revert UnauthorizedSessionKey();
            if (currentAllowance < totalAmount) revert AllowanceExceeded(totalAmount, currentAllowance);

            // Safe: currentAllowance >= totalAmount verified above
            unchecked {
                sessionKeyAllowances[from][msg.sender] = currentAllowance - totalAmount;
            }
        }

        // ── Interactions ────────────────────────────────────────────────
        IERC20 paymentToken = IERC20(token);

        if (fee > 0) {
            paymentToken.safeTransferFrom(from, treasury, fee);
        }

        paymentToken.safeTransferFrom(from, merchant, amount);

        emit PaymentRouted(token, from, merchant, msg.sender, amount, fee);
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function setTreasury(address _newTreasury) external {
        if (msg.sender != treasury) revert Unauthorized();
        if (_newTreasury == address(0)) revert InvalidAddress();

        address old = treasury;
        treasury = _newTreasury;
        emit TreasuryUpdated(old, _newTreasury);
    }

    /// @notice Emergency pause — freezes all payments.
    function pause() external {
        if (msg.sender != treasury) revert Unauthorized();
        _pause();
    }

    /// @notice Unpause — resumes payments.
    function unpause() external {
        if (msg.sender != treasury) revert Unauthorized();
        _unpause();
    }

    // ── UUPS upgrade authorization ──────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != treasury) revert Unauthorized();
    }
}
