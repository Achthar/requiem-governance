// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v4.5.0) (token/ERC20/extensions/ERC20Votes.sol)

pragma solidity ^0.8.17;

import "./token/ERC20/extensions/draft-ERC20Permit.sol";
import "./interfaces/IERC20.sol";
import "./libraries/math/Math.sol";
import "./libraries/Context.sol";
import "./access/Ownable.sol";
import "./utils/IVotesRegister.sol";
import "./libraries/math/SafeCast.sol";
import "./libraries/cryptography/ECDSA.sol";
import "./libraries/cryptography/draft-EIP712.sol";

// solhint-disable max-line-length

/**
 * @dev Voting register that allows Compound-like voting and delegation for multiple tokens that call respective functions on transfers. This version is more generic than Compound's,
 * and supports token supply up to 2^224^ - 1, while COMP is limited to 2^96^ - 1.
 *
 * NOTE: If exact COMP compatibility is required, use the {ERC20VotesComp} variant of this module.
 *
 * This extension keeps a history (checkpoints) of each account's vote power. Vote power can be delegated either
 * by calling the {delegate} function directly, or by providing a signature to be used with {delegateBySig}. Voting
 * power can be queried through the public accessors {getVotes} and {getPastVotes}.
 *
 * By default, token balance does not account for voting power. This makes transfers cheaper. The downside is that it
 * requires users to delegate to themselves in order to activate checkpoints and have their voting power tracked.
 *
 * _Available since v4.2._
 */
contract VotesRegister is IVotesRegister, Context, Ownable, EIP712 {
    struct Checkpoint {
        uint32 fromBlock;
        uint224 votes;
    }

    bytes32 private constant _DELEGATION_TYPEHASH = keccak256("Delegation(address pool,address delegatee,uint256 nonce,uint256 expiry)");

    // flag whether address is authorized to register and deregister pool tokens
    mapping(address => bool) private _authorized;

    // flag for registered tokens for which the checkpoints and votes are tracked with this contract
    mapping(address => bool) private _registeredTokens;

    // maps as follows: pool -> user -> delegate
    mapping(address => mapping(address => address)) private _delegates;

    // maps as follows: pool -> user -> checkpoints
    mapping(address => mapping(address => Checkpoint[])) private _checkpoints;

    // maps as follows: pool -> totalSupply of pool LP token
    mapping(address => Checkpoint[]) private _totalSupplyCheckpoints;

    function authorize(address entity) public onlyOwner {
        _authorized[entity] = true;
    }

    function removeAuthorization(address entity) public onlyOwner {
        _authorized[entity] = false;
    }

    function registerToken(address token) public {
        require(_authorized[_msgSender()], "VotesRegister: unauthorized");
        _registeredTokens[token] = true;
    }

    function unregisterToken(address token) public {
        require(_authorized[_msgSender()], "VotesRegister: unauthorized");
        _registeredTokens[token] = false;
    }

    function isAuthorized(address entity) public view returns (bool) {
        return _authorized[entity];
    }

    function isRegistered(address token) public view returns (bool) {
        return _registeredTokens[token];
    }

    function balanceOf(address user, address pool) public view returns (uint256) {
        return IERC20(pool).balanceOf(user);
    }

    /**
     * @dev Get the `pos`-th checkpoint for `account`.
     */
    function checkpoints(
        address account,
        address pool,
        uint32 pos
    ) public view virtual returns (Checkpoint memory) {
        return _checkpoints[pool][account][pos];
    }

    /**
     * @dev Get number of checkpoints for `account`.
     */
    function numCheckpoints(address account, address pool) public view virtual returns (uint32) {
        return SafeCast.toUint32(_checkpoints[pool][account].length);
    }

    /**
     * @dev Get the address `account` is currently delegating to.
     */
    function delegates(address account, address pool) public view virtual override returns (address) {
        return _delegates[pool][account];
    }

    /**
     * @dev Gets the current votes balance for `account`
     */
    function getVotes(address account, address pool) public view virtual override returns (uint256) {
        uint256 pos = _checkpoints[pool][account].length;
        return pos == 0 ? 0 : _checkpoints[pool][account][pos - 1].votes;
    }

    /**
     * @dev Retrieve the number of votes for `account` at the end of `blockNumber`.
     *
     * Requirements:
     *
     * - `blockNumber` must have been already mined
     */
    function getPastVotes(
        address account,
        address pool,
        uint256 blockNumber
    ) public view virtual override returns (uint256) {
        require(blockNumber < block.number, "VotesRegister: block not yet mined");
        return _checkpointsLookup(_checkpoints[pool][account], blockNumber);
    }

    /**
     * @dev Retrieve the `totalSupply` at the end of `blockNumber`. Note, this value is the sum of all balances.
     * It is but NOT the sum of all the delegated votes!
     *
     * Requirements:
     *
     * - `blockNumber` must have been already mined
     */
    function getPastTotalSupply(address pool, uint256 blockNumber) public view virtual override returns (uint256) {
        require(blockNumber < block.number, "VotesRegister: block not yet mined");
        return _checkpointsLookup(_totalSupplyCheckpoints[pool], blockNumber);
    }

    /**
     * @dev Lookup a value in a list of (sorted) checkpoints.
     */
    function _checkpointsLookup(Checkpoint[] storage ckpts, uint256 blockNumber) private view returns (uint256) {
        // We run a binary search to look for the earliest checkpoint taken after `blockNumber`.
        //
        // During the loop, the index of the wanted checkpoint remains in the range [low-1, high).
        // With each iteration, either `low` or `high` is moved towards the middle of the range to maintain the invariant.
        // - If the middle checkpoint is after `blockNumber`, we look in [low, mid)
        // - If the middle checkpoint is before or equal to `blockNumber`, we look in [mid+1, high)
        // Once we reach a single value (when low == high), we've found the right checkpoint at the index high-1, if not
        // out of bounds (in which case we're looking too far in the past and the result is 0).
        // Note that if the latest checkpoint available is exactly for `blockNumber`, we end up with an index that is
        // past the end of the array, so we technically don't find a checkpoint after `blockNumber`, but it works out
        // the same.
        uint256 high = ckpts.length;
        uint256 low = 0;
        while (low < high) {
            uint256 mid = Math.average(low, high);
            if (ckpts[mid].fromBlock > blockNumber) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }

        return high == 0 ? 0 : ckpts[high - 1].votes;
    }

    /**
     * @dev Delegate votes from the sender to `delegatee`.
     */
    function delegate(address delegatee, address pool) public virtual override {
        _delegate(_msgSender(), delegatee, pool);
    }

    /**
     * @dev Delegates votes from signer to `delegatee`
     */
    function delegateBySig(
        address delegatee,
        address pool,
        uint256 nonce,
        uint256 expiry,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public virtual override {
        require(block.timestamp <= expiry, "VotesRegister: signature expired");
        address signer = ECDSA.recover(_hashTypedDataV4(keccak256(abi.encode(_DELEGATION_TYPEHASH, pool, delegatee, nonce, expiry))), v, r, s);
        require(nonce == _useNonce(signer), "VotesRegister: invalid nonce");
        _delegate(signer, delegatee, pool);
    }

    /**
     * @dev Snapshots the totalSupply after it has been increased.
     * @notice has only effect if a registered token is calling. Adjusts checkpoints and voting power
     * according to the amount minted. Must not be implemented together with onAfterTokenTransfer as
     * we want to avoid two external calls in the token contract on mint.
     */
    function onMint(address account, uint256 amount) external virtual {
        if (_registeredTokens[_msgSender()]) {
            address pool = _msgSender();
            _writeCheckpoint(_totalSupplyCheckpoints[pool], _add, amount);
            _moveVotingPower(pool, delegates(address(0), pool), delegates(account, pool), amount);
        }
    }

    /**
     * @dev Snapshots the totalSupply after it has been decreased.
     * @notice has only effect if a registered token is calling. Adjusts checkpoints and voting power
     * according to the amount minted. Must not be implemented together with onAfterTokenTransfer as
     * we want to avoid two external calls in the token contract on burn.
     */
    function onBurn(address account, uint256 amount) external virtual {
        if (_registeredTokens[_msgSender()]) {
            address pool = _msgSender();
            _writeCheckpoint(_totalSupplyCheckpoints[pool], _subtract, amount);
            _moveVotingPower(pool, delegates(address(0), pool), delegates(account, pool), amount);
        }
    }

    /**
     * @dev Move voting power when tokens are transferred. Must be called of a registered token after transfer
     * but not together with onMint and onBurn as these already call the _moveVotingPower function
     *
     * Emits a {DelegateVotesChanged} event.
     */
    function onAfterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) external virtual {
        address pool = msg.sender;
        if (_registeredTokens[pool]) {
            _moveVotingPower(pool, delegates(from, pool), delegates(to, pool), amount);
        }
    }

    /**
     * @dev Change delegation for `delegator` to `delegatee`.
     *
     * Emits events {DelegateChanged} and {DelegateVotesChanged}.
     */
    function _delegate(
        address delegator,
        address delegatee,
        address pool
    ) internal virtual {
        address currentDelegate = delegates(delegator, pool);
        uint256 delegatorBalance = balanceOf(delegator, pool);
        _delegates[pool][delegator] = delegatee;

        emit DelegateChanged(pool, delegator, currentDelegate, delegatee);

        _moveVotingPower(pool, currentDelegate, delegatee, delegatorBalance);
    }

    function _moveVotingPower(
        address pool,
        address src,
        address dst,
        uint256 amount
    ) private {
        if (src != dst && amount > 0) {
            if (src != address(0)) {
                (uint256 oldWeight, uint256 newWeight) = _writeCheckpoint(_checkpoints[pool][src], _subtract, amount);
                emit DelegateVotesChanged(pool, src, oldWeight, newWeight);
            }

            if (dst != address(0)) {
                (uint256 oldWeight, uint256 newWeight) = _writeCheckpoint(_checkpoints[pool][dst], _add, amount);
                emit DelegateVotesChanged(pool, dst, oldWeight, newWeight);
            }
        }
    }

    function _writeCheckpoint(
        Checkpoint[] storage ckpts,
        function(uint256, uint256) view returns (uint256) op,
        uint256 delta
    ) private returns (uint256 oldWeight, uint256 newWeight) {
        uint256 pos = ckpts.length;
        oldWeight = pos == 0 ? 0 : ckpts[pos - 1].votes;
        newWeight = op(oldWeight, delta);

        if (pos > 0 && ckpts[pos - 1].fromBlock == block.number) {
            ckpts[pos - 1].votes = SafeCast.toUint224(newWeight);
        } else {
            ckpts.push(Checkpoint({fromBlock: SafeCast.toUint32(block.number), votes: SafeCast.toUint224(newWeight)}));
        }
    }

    function _add(uint256 a, uint256 b) private pure returns (uint256) {
        return a + b;
    }

    function _subtract(uint256 a, uint256 b) private pure returns (uint256) {
        return a - b;
    }

    using Counters for Counters.Counter;

    mapping(address => Counters.Counter) private _nonces;

    // solhint-disable-next-line var-name-mixedcase
    bytes32 private constant _PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    /**
     * @dev In previous versions `_PERMIT_TYPEHASH` was declared as `immutable`.
     * However, to ensure consistency with the upgradeable transpiler, we will continue
     * to reserve a slot.
     * @custom:oz-renamed-from _PERMIT_TYPEHASH
     */
    // solhint-disable-next-line var-name-mixedcase
    bytes32 private _PERMIT_TYPEHASH_DEPRECATED_SLOT;

    /**
     * @dev Initializes the {EIP712} domain separator using the `name` parameter, and setting `version` to `"1"`.
     *
     * It's a good idea to use the same `name` that is defined as the ERC20 token name.
     */
    constructor() EIP712("Requiem Pool Voting Register", "1") {}

    /**
     * @dev See {IERC20Permit-nonces}.
     */
    function nonces(address owner) public view virtual returns (uint256) {
        return _nonces[owner].current();
    }

    /**
     * @dev Returns the contract's {EIP712} domain separator.
     */
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /**
     * @dev "Consume a nonce": return the current value and increment.
     *
     * _Available since v4.1._
     */
    function _useNonce(address owner) internal virtual returns (uint256 current) {
        Counters.Counter storage nonce = _nonces[owner];
        current = nonce.current();
        nonce.increment();
    }
}
