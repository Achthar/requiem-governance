// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v4.5.0) (token/ERC20/extensions/ERC20Votes.sol)

pragma solidity ^0.8.17;

import "./interfaces/IERC20.sol";
import "./utils/IVotesRegisterUpgradeable.sol";
import "./upgradeable/access/OwnableUpgradeable.sol";
import "./upgradeable/utils/math/MathUpgradeable.sol";
import "./upgradeable/utils/ContextUpgradeable.sol";
import "./upgradeable/utils/math/SafeCastUpgradeable.sol";
import "./upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";
import "./upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import "./upgradeable/utils/CheckpointsUpgradeable.sol";
import "./upgradeable/utils/CountersUpgradeable.sol";

// solhint-disable max-line-length

/**
 * @dev Voting register that allows Compound-like voting and delegation for multiple tokens that call respective functions on transfers. This version is more generic than Compound's,
 * and supports token supply up to 2^224^ - 1, while COMP is limited to 2^96^ - 1.
 * That supply cap is not enforced in this logic as it would impair tradability of the tokens themselves.
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
contract RequiemVotesRegister is IVotesRegisterUpgradeable, Initializable, ContextUpgradeable, OwnableUpgradeable, EIP712Upgradeable {
    using CountersUpgradeable for CountersUpgradeable.Counter;

    struct CheckpointUpgradeable {
        uint32 fromBlock;
        uint224 votes;
    }

    mapping(address => CountersUpgradeable.Counter) private _nonces;

    bytes32 private constant _DELEGATION_TYPEHASH = keccak256("Delegation(address token,address delegatee,uint256 nonce,uint256 expiry)");

    // flag whether address is authorized to register and deregister tokens
    mapping(address => bool) private _authorized;

    // flag for registered tokens for which the checkpoints and votes are tracked with this contract
    mapping(address => bool) private _registeredTokens;

    // maps as follows: token -> user -> delegate
    mapping(address => mapping(address => address)) private _delegates;

    // maps as follows: token -> user -> checkpoints
    mapping(address => mapping(address => CheckpointUpgradeable[])) private _checkpoints;

    // maps as follows: token -> totalSupply of token LP token
    mapping(address => CheckpointUpgradeable[]) private _totalSupplyCheckpoint;

    function initialize(string memory name) public initializer {
        __Context_init();
        __Ownable_init();
        __EIP712_init_unchained(name, "1");
    }

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

    function balanceOf(address user, address token) public view returns (uint256) {
        return IERC20(token).balanceOf(user);
    }

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
     * @dev Get the `pos`-th checkpoint for `account`.
     */
    function checkpoints(
        address account,
        address token,
        uint32 pos
    ) public view virtual returns (CheckpointUpgradeable memory) {
        return _checkpoints[token][account][pos];
    }

    /**
     * @dev Get number of checkpoints for `account`.
     */
    function numCheckpoints(address account, address token) public view virtual returns (uint32) {
        return SafeCastUpgradeable.toUint32(_checkpoints[token][account].length);
    }

    /**
     * @dev Get the address `account` is currently delegating to.
     */
    function delegates(address account, address token) public view virtual override returns (address) {
        return _delegates[token][account];
    }

    /**
     * @dev Gets the current votes balance for `account`
     */
    function getVotes(address account, address token) public view virtual override returns (uint256) {
        uint256 pos = _checkpoints[token][account].length;
        return pos == 0 ? 0 : _checkpoints[token][account][pos - 1].votes;
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
        address token,
        uint256 blockNumber
    ) public view virtual override returns (uint256) {
        require(blockNumber < block.number, "VotesRegister: block not yet mined");
        return _checkpointsLookup(_checkpoints[token][account], blockNumber);
    }

    /**
     * @dev Retrieve the `totalSupply` at the end of `blockNumber`. Note, this value is the sum of all balances.
     * It is but NOT the sum of all the delegated votes!
     *
     * Requirements:
     *
     * - `blockNumber` must have been already mined
     */
    function getPastTotalSupply(address token, uint256 blockNumber) public view virtual override returns (uint256) {
        require(blockNumber < block.number, "VotesRegister: block not yet mined");
        return _checkpointsLookup(_totalSupplyCheckpoint[token], blockNumber);
    }

    /**
     * @dev Lookup a value in a list of (sorted) checkpoints.
     */
    function _checkpointsLookup(CheckpointUpgradeable[] storage ckpts, uint256 blockNumber) private view returns (uint256) {
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
            uint256 mid = MathUpgradeable.average(low, high);
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
    function delegate(address delegatee, address token) public virtual override {
        _delegate(_msgSender(), delegatee, token);
    }

    /**
     * @dev Delegates votes from signer to `delegatee`
     */
    function delegateBySig(
        address delegatee,
        address token,
        uint256 nonce,
        uint256 expiry,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public virtual override {
        require(block.timestamp <= expiry, "VotesRegister: signature expired");
        address signer = ECDSAUpgradeable.recover(
            _hashTypedDataV4(keccak256(abi.encode(_DELEGATION_TYPEHASH, token, delegatee, nonce, expiry))),
            v,
            r,
            s
        );
        require(nonce == _useNonce(signer), "VotesRegister: invalid nonce");
        _delegate(signer, delegatee, token);
    }

    /**
     * @dev Snapshots the totalSupply after it has been increased.
     * @notice has only effect if a registered token is calling. Adjusts checkpoints and voting power
     * according to the amount minted. Must not be implemented together with onAfterTokenTransfer as
     * we want to avoid two external calls in the token contract on mint.
     */
    function onMint(address account, uint256 amount) external virtual {
        address token = _msgSender();
        if (_registeredTokens[token]) {
            _writeCheckpoint(_totalSupplyCheckpoint[token], _add, amount);
            _moveVotingPower(token, delegates(address(0), token), delegates(account, token), amount);
        }
    }

    /**
     * @dev Snapshots the totalSupply after it has been decreased.
     * @notice has only effect if a registered token is calling. Adjusts checkpoints and voting power
     * according to the amount minted. Must not be implemented together with onAfterTokenTransfer as
     * we want to avoid two external calls in the token contract on burn.
     */
    function onBurn(address account, uint256 amount) external virtual {
        address token = _msgSender();
        if (_registeredTokens[token]) {
            _writeCheckpoint(_totalSupplyCheckpoint[token], _subtract, amount);
            _moveVotingPower(token, delegates(account, token), delegates(address(0), token), amount);
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
        address token = _msgSender();
        if (_registeredTokens[token]) {
            _moveVotingPower(token, delegates(from, token), delegates(to, token), amount);
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
        address token
    ) internal virtual {
        address currentDelegate = delegates(delegator, token);
        uint256 delegatorBalance = balanceOf(delegator, token);
        _delegates[token][delegator] = delegatee;

        emit DelegateChanged(token, delegator, currentDelegate, delegatee);

        _moveVotingPower(token, currentDelegate, delegatee, delegatorBalance);
    }

    function _moveVotingPower(
        address token,
        address src,
        address dst,
        uint256 amount
    ) private {
        if (src != dst && amount > 0) {
            if (src != address(0)) {
                (uint256 oldWeight, uint256 newWeight) = _writeCheckpoint(_checkpoints[token][src], _subtract, amount);
                emit DelegateVotesChanged(token, src, oldWeight, newWeight);
            }

            if (dst != address(0)) {
                (uint256 oldWeight, uint256 newWeight) = _writeCheckpoint(_checkpoints[token][dst], _add, amount);
                emit DelegateVotesChanged(token, dst, oldWeight, newWeight);
            }
        }
    }

    function _writeCheckpoint(
        CheckpointUpgradeable[] storage ckpts,
        function(uint256, uint256) view returns (uint256) op,
        uint256 delta
    ) private returns (uint256 oldWeight, uint256 newWeight) {
        uint256 pos = ckpts.length;
        oldWeight = pos == 0 ? 0 : ckpts[pos - 1].votes;
        newWeight = op(oldWeight, delta);

        if (pos > 0 && ckpts[pos - 1].fromBlock == block.number) {
            ckpts[pos - 1].votes = SafeCastUpgradeable.toUint224(newWeight);
        } else {
            ckpts.push(
                CheckpointUpgradeable({fromBlock: SafeCastUpgradeable.toUint32(block.number), votes: SafeCastUpgradeable.toUint224(newWeight)})
            );
        }
    }

    /**
     * @dev "Consume a nonce": return the current value and increment.
     *
     * _Available since v4.1._
     */
    function _useNonce(address owner) internal virtual returns (uint256 current) {
        CountersUpgradeable.Counter storage nonce = _nonces[owner];
        current = nonce.current();
        nonce.increment();
    }

    function _add(uint256 a, uint256 b) private pure returns (uint256) {
        return a + b;
    }

    function _subtract(uint256 a, uint256 b) private pure returns (uint256) {
        return a - b;
    }
}
