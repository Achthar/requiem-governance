// SPDX-License-Identifier: MIT

pragma solidity ^0.8.17;

import "./upgradeable/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "./upgradeable/ERC20/extensions/ERC20VotesUpgradeable.sol";
import "./upgradeable/ERC20/utils/SafeERC20Upgradeable.sol";
import "./upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import "./upgradeable/access/OwnableUpgradeable.sol";
import "./interfaces/governance/IGovernanceRequiem.sol";
import "./interfaces/governance/ICurveProvider.sol";
import "./interfaces/governance/ILockKeeper.sol";
import "./upgradeable/ERC20/IERC20Upgradeable.sol";

// solhint-disable max-line-length

/// @title Requiem Governance Token
/// @author Achthar

contract GovernanceRequiemToken is ILockKeeper, IGovernanceRequiem, ERC20BurnableUpgradeable, ERC20VotesUpgradeable, OwnableUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.UintSet;

    // flags
    uint256 private _unlocked;

    // constants
    uint256 public constant MAXTIME = 365 * 1 days;
    uint256 public constant MINTIME = 60 * 60;
    uint256 public constant MAX_WITHDRAWAL_PENALTY = 50000; // 50%
    uint256 public constant PRECISION = 100000; // 5 decimals

    address public curveProvider;
    address public lockedToken;
    uint256 public minLockedAmount;
    uint256 public earlyWithdrawPenaltyRate;

    // lock variables
    // counter to generate ids for locks
    uint256 public lockCount;

    // user address -> end times -> locked position
    mapping(address => mapping(uint256 => LockedBalance)) public lockedPositions;

    // tracks the ids for locks per user
    mapping(address => EnumerableSetUpgradeable.UintSet) internal lockIds;

    /* ========== MODIFIERS ========== */

    modifier lock() {
        require(_unlocked == 1, "LOCKED");
        _unlocked = 0;
        _;
        _unlocked = 1;
    }

    constructor() {}

    function initialize(
        string memory _name,
        string memory _symbol,
        address _lockedToken,
        address _curveProvider,
        uint256 _minLockedAmount
    ) public initializer {
        __ERC20_init(_name, _symbol);
        __Ownable_init();
        __Context_init();
        __ERC20Burnable_init();
        __ERC20Permit_init(_name);
        __ERC20Votes_init();

        lockedToken = _lockedToken;
        minLockedAmount = _minLockedAmount;
        earlyWithdrawPenaltyRate = 30000; // 30%
        _unlocked = 1;
        curveProvider = _curveProvider;
    }

    /* ========== PUBLIC FUNCTIONS ========== */

    /**
     * @notice Calculates the total amount of locked tokens for the given user
     * @param _addr user address
     * @return _userAmount the total locked balance for given address
     */
    function getTotalAmountLocked(address _addr) external view returns (uint256 _userAmount) {
        for (uint256 i = 0; i < lockIds[_addr].length(); i++) {
            uint256 _id = lockIds[_addr].at(i);
            _userAmount += lockedPositions[_addr][_id].amount;
        }
    }

    /**
     * @notice Returns indexes which are referring to locked positions for user
     * @param _addr user address
     * @return _indexes indexes for user
     */
    function getUserIndexes(address _addr) public view returns (uint256[] memory _indexes) {
        uint256 _count = lockIds[_addr].length();
        _indexes = new uint256[](_count);
        for (uint256 i = 0; i < _count; i++) {
            _indexes[i] = lockIds[_addr].at(i);
        }
    }

    /**
     * @notice Calculates the total voting power for the given user
     * @param _addr user address
     * @return _votingPower the total voting power for given address
     */
    function getUserMinted(address _addr) external view returns (uint256 _votingPower) {
        for (uint256 i = 0; i < lockIds[_addr].length(); i++) {
            uint256 _id = lockIds[_addr].at(i);
            _votingPower += lockedPositions[_addr][_id].minted;
        }
    }

    /**
     * @notice Calculates the minted amount oof governance tokens for a newly created lock
     * @param _value Amount of locked token
     * @param _startTime start of the lock time (usually current timestamp)
     * @param _unlockTime time after which users can withdraw without penalty
     * @return the amount of minted governance tokens
     */
    function getAmountMinted(
        uint256 _value,
        uint256 _startTime,
        uint256 _unlockTime
    ) public view returns (uint256) {
        if (_unlockTime - _startTime > MAXTIME) return _value;
        return
            (_value *
                ICurveProvider(curveProvider).rate(
                    MAXTIME,
                    _startTime,
                    _unlockTime,
                    IERC20Upgradeable(lockedToken).totalSupply(),
                    this.totalSupply()
                )) / 1e18;
    }

    /**
     * @notice Calculates the added amount of governacne tokens for an increased maturity
     * @param _value Amount of locked token
     * @param _now current timestamp
     * @param _startTime start of the lock time
     * @param _unlockTime time after which users can withdraw without penalty
     * @return the amount of minted governance tokens
     */
    function getAdditionalAmountMinted(
        uint256 _value,
        uint256 _now,
        uint256 _startTime,
        uint256 _unlockTime
    ) public view returns (uint256) {
        // start time has to be adjusted if _start time is in the past
        uint256 _adjustedStart = _now > _startTime ? _now : _startTime;
        if (_unlockTime - _adjustedStart > MAXTIME) return _value;

        return
            (_value *
                ICurveProvider(curveProvider).forwardRate(
                    MAXTIME,
                    _now,
                    _adjustedStart,
                    _unlockTime,
                    IERC20Upgradeable(lockedToken).totalSupply(),
                    this.totalSupply()
                )) / 1e18;
    }

    /**
     * Create new lock with defined maturity time
     * - That shall help standardizing these positions
     * @param _value amount to lock
     * @param _end expiry timestamp
     */
    function createLock(
        uint256 _value,
        uint256 _end,
        address _recipient
    ) external override lock returns (uint256 _newId) {
        uint256 _now = block.timestamp;
        require(_end > _now, "invalid end");
        uint256 _duration = _end - _now;
        require(_value >= minLockedAmount, "< min amount");
        require(_duration >= MINTIME, "< MINTIME");
        require(_duration <= MAXTIME, "> MAXTIME");

        uint256 _vp = getAmountMinted(_value, _now, _end);
        require(_vp > 0, "No benefit to lock");

        IERC20Upgradeable(lockedToken).safeTransferFrom(_msgSender(), address(this), _value);
        _mint(_recipient, _vp);

        _newId = _addLock(_recipient, _value, _vp, _now, _end);
    }

    /**
     * Increases the maturity of _amount from _end to _newEnd
     * @param _amount amount to change the maturity for
     * @param _id id of lock
     * @param _newEnd new maturity
     */
    function increaseTimeToMaturity(
        uint256 _amount,
        uint256 _id,
        uint256 _newEnd
    ) external override lock returns (uint256 _newId) {
        uint256 _now = block.timestamp;
        uint256 _duration = _newEnd - _now;
        require(_duration >= MINTIME, "< MINTIME");
        require(_duration <= MAXTIME, "> MAXTIME");
        uint256 _lockedAmount = lockedPositions[_msgSender()][_id].amount;
        if (_amount == _lockedAmount) {
            _extendMaturity(_msgSender(), _id, _newEnd);
        } else if (_amount < _lockedAmount) {
            _newId = _splitLock(_msgSender(), _amount, _id, _msgSender());
            _extendMaturity(_msgSender(), _newId, _newEnd);
        } else {
            revert("invalid amount");
        }
    }

    /**
     * Function to increase position for given _id
     * @param _value increase position for position in _id by value
     * @param _id id of the position to increase
     * @param _recipient add funds for given user
     */
    function increasePosition(
        uint256 _value,
        uint256 _id,
        address _recipient
    ) external override lock {
        require(_value >= minLockedAmount, "< min amount");
        _increasePosition(_recipient, _value, _id);
    }

    /**
     * Function to increase position for given _id
     * @param _amount increase position for position in _id by value
     * @param _id id of the position to increase
     * @param _recipient add funds for given user
     */
    function splitLock(
        uint256 _amount,
        uint256 _id,
        address _recipient
    ) external override lock returns (uint256 _newId) {
        require(_amount >= minLockedAmount, "< min amount for new lock");
        _newId = _splitLock(_msgSender(), _amount, _id, _recipient);
    }

    /**
     * @notice Merges two locks of the user. The one with the lower maturity will be extended to match the other.
     */
    function mergeLocks(uint256 _firstId, uint256 _secondId) external override lock returns (uint256 _remainingId) {
        require(_firstId != _secondId, "invalid Id constellation");
        require(_lockExists(_msgSender(), _secondId) && _lockExists(_msgSender(), _firstId), "nothing to merge");

        (uint256 _lateId, uint256 _earlyId) = lockedPositions[_msgSender()][_firstId].end > lockedPositions[_msgSender()][_secondId].end
            ? (_firstId, _secondId)
            : (_secondId, _firstId);

        LockedBalance memory _earlyLock = lockedPositions[_msgSender()][_earlyId];
        LockedBalance storage _lateLock = lockedPositions[_msgSender()][_lateId];

        uint256 _earlyAmount = _earlyLock.amount;
        uint256 _lateAmount = _lateLock.amount;
        uint256 _totalAmount = _earlyAmount + _lateAmount;

        // assign new amount to lock to keep
        _lateLock.amount = _totalAmount;

        // different maturities mean that we have to increase the one of the lower
        if (lockedPositions[_msgSender()][_firstId].end != lockedPositions[_msgSender()][_secondId].end) {
            // calculate extended amount for old lock
            uint256 _vpDiff = getAdditionalAmountMinted(_earlyAmount, block.timestamp, _earlyLock.end, _lateLock.end);
            uint256 _newVpEarly = _vpDiff + _earlyLock.minted;
            uint256 _earlyMintedNew = _newVpEarly > _earlyAmount ? _earlyAmount : _newVpEarly;

            // make sure the minted governance tokens are capped
            _lateLock.minted += _earlyMintedNew;

            // mint the added amount of governance tokens
            _mint(_msgSender(), _earlyMintedNew - _earlyLock.minted);
        } else {
            // in this case the maturities are the same, we only need to add the minted amounts
            _lateLock.minted = _earlyLock.minted + _lateLock.minted;
        }

        // delete the lock with earlyId
        _deleteLock(_msgSender(), _earlyId);
        _lateLock.start = _weightedSum(_lateLock.start, _earlyLock.start, _lateAmount, _earlyAmount);
        _remainingId = _lateId;
    }

    /**
     * @notice Withdraws from all locks whenever possible
     */
    function withdrawAll() external {
        uint256[] memory _ids = getUserIndexes(_msgSender());
        for (uint256 i = 0; i < _ids.length; i++) {
            uint256 _id = _ids[i];
            LockedBalance storage _lock = lockedPositions[_msgSender()][_id];
            uint256 _locked = _lock.amount;
            uint256 _now = block.timestamp;
            if (_locked > 0 && _now >= _lock.end) {
                // burn minted amount
                _burn(_msgSender(), _lock.minted);

                // delete lock entry
                _deleteLock(_msgSender(), _id);

                IERC20Upgradeable(lockedToken).safeTransfer(_msgSender(), _locked);

                emit Withdraw(_msgSender(), _locked, _now);
            }
        }
    }

    /**
     * @notice Withdraws from specific lock if possible
     * @param _id id of the position to increase
     * @param _amount amount to withdraw fromn lock
     */
    function withdraw(uint256 _id, uint256 _amount) external lock {
        LockedBalance storage _lock = lockedPositions[_msgSender()][_id];
        uint256 _now = block.timestamp;
        uint256 _locked = _lock.amount;
        require(_locked > 0, "Nothing to withdraw");
        require(_now >= _lock.end, "The lock didn't expire");
        if (_amount == _locked) {
            // burn minted amount
            _burn(_msgSender(), _lock.minted);

            // delete lock entry
            _deleteLock(_msgSender(), _id);
        } else if (_amount < _locked) {
            require(_locked - _amount >= minLockedAmount, "< min amount left in lock");
            uint256 _minted = _shareOf(_lock.minted, _amount, _locked);
            _lock.amount -= _amount;
            _lock.minted -= _minted;
            _burn(_msgSender(), _minted);
        } else {
            revert("insufficient amount in lock");
        }

        IERC20Upgradeable(lockedToken).safeTransfer(_msgSender(), _amount);

        emit Withdraw(_msgSender(), _amount, _now);
    }

    /**
     * @notice Withdraws from specific lock - this will charge PENALTY if lock is not expired yet.
     * @param _id id of the position to withdraw
     */
    function emergencyWithdraw(uint256 _id) external {
        LockedBalance memory _lock = lockedPositions[_msgSender()][_id];
        uint256 _amount = _lock.amount;
        uint256 _now = block.timestamp;
        require(_amount > 0, "Nothing to withdraw");
        if (_now < _lock.end) {
            uint256 _fee = (_amount * earlyWithdrawPenaltyRate) / PRECISION;
            _penalize(_fee);
            _amount -= _fee;
        }

        // burn amount
        _burn(_msgSender(), _lock.minted);

        // remove lock
        _deleteLock(_msgSender(), _id);

        IERC20Upgradeable(lockedToken).safeTransfer(_msgSender(), _amount);

        emit Withdraw(_msgSender(), _amount, _now);
    }

    /**
     * @notice Withdraws from all locks available for user - this will charge PENALTY if lock is not expired yet.
     */
    function emergencyWithdrawAll() external {
        uint256 _now = block.timestamp;
        uint256[] memory _ids = getUserIndexes(_msgSender());
        for (uint256 i = 0; i < _ids.length; i++) {
            uint256 _id = _ids[i];
            LockedBalance memory _lock = lockedPositions[_msgSender()][_id];
            uint256 _locked = _lock.amount;
            if (_locked > 0) {
                if (_now < _lock.end) {
                    uint256 _fee = (_locked * earlyWithdrawPenaltyRate) / PRECISION;
                    _penalize(_fee);
                    _locked -= _fee;
                }

                _burn(_msgSender(), _lock.minted);

                // delete lock
                _deleteLock(_msgSender(), _id);

                IERC20Upgradeable(lockedToken).safeTransfer(_msgSender(), _locked);

                emit Withdraw(_msgSender(), _locked, _now);
            }
        }
    }

    /**
     * @dev Function that transfers the share of the underlying lock amount to the recipient.
     * @param _amount amount of locked token to transfer
     * @param _id id of lock to transfer
     * @param _to recipient address
     */
    function transferLock(
        uint256 _amount,
        uint256 _id,
        address _to,
        bool _sendTokens
    ) external override lock returns (uint256 _receivedId) {
        LockedBalance memory _lock = lockedPositions[_msgSender()][_id];
        require(_amount <= _lock.amount, "Insufficient funds in Lock");
        require(_amount >= minLockedAmount, "< min amount");
        uint256 _vpToSend;
        if (_amount == _lock.amount) {
            // log the amount for the recipient
            _receiveLock(_id, _lock, _to);
            _vpToSend = _lock.minted;

            // reduce this users lock data
            _deleteLock(_msgSender(), _id);

            // full transfer means that the id is just moved
            _receivedId = _id;
        } else if (_amount < _lock.amount) {
            _vpToSend = _shareOf(_lock.minted, _amount, _lock.amount);

            // adjust lock before transfer
            _lock.amount = _amount;
            _lock.minted = _vpToSend;
            _receivedId = lockCount;
            // log the amount for the recipient - create new lock
            _receiveLock(_receivedId, _lock, _to);
            // increase count
            lockCount += 1;

            // reduce this users lock amount
            lockedPositions[_msgSender()][_id].amount -= _amount;

            // reduce related voting power
            lockedPositions[_msgSender()][_id].minted -= _vpToSend;
        } else {
            revert("invalid amount");
        }

        if (_sendTokens) this.transferFrom(_msgSender(), _to, _vpToSend);
    }

    /* ========== PUBLIC FUNCTIONS LOCK KEEER ========== */

    /**
     * Gets lock data for user
     * @param _addr user to get data of
     * @return _balances LockedBalance aray for user
     */
    function getLocks(address _addr) external view override returns (LockedBalance[] memory _balances) {
        uint256 length = lockIds[_addr].length();
        _balances = new LockedBalance[](length);
        for (uint256 i = 0; i < length; i++) {
            _balances[i] = lockedPositions[_addr][lockIds[_addr].at(i)];
        }
    }

    /**
     * Cheks whether a lock exists
     * @param _addr user to get data of
     * @param _end expiry of lock
     * @return true if lock exists, false if not
     */
    function lockExists(address _addr, uint256 _end) external view override returns (bool) {
        return _lockExists(_addr, _end);
    }

    function _lockExists(address _addr, uint256 _id) internal view returns (bool) {
        return lockIds[_addr].contains(_id);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    /**
     * Extends the maturity of one lock
     * @param _addr user
     * @param _id id of locked amount to move
     * @param _newEnd target end
     */
    function _extendMaturity(
        address _addr,
        uint256 _id,
        uint256 _newEnd
    ) internal {
        LockedBalance storage _lock = lockedPositions[_addr][_id];
        uint256 _lockEnd = _lock.end;
        require(_lockEnd < _newEnd, "new end has to be later");
        uint256 _amount = _lock.amount;
        uint256 _vp = _lock.minted;
        uint256 _vpAdded = getAdditionalAmountMinted(_amount, block.timestamp, _lockEnd, _newEnd);
        uint256 _newLocked = _lock.amount + _amount;

        uint256 _totalNewMinted = _vp + _vpAdded;
        _newLocked = _lock.amount + _amount;
        uint256 _vpNew = _totalNewMinted >= _newLocked ? _newLocked : _totalNewMinted;

        // set new minted amount
        _lock.minted = _vpNew;

        // adjust end
        _lock.end = _newEnd;

        uint256 _vpDiff = _vpNew - _vp;
        require(_vpDiff > 0, "No benefit to lock");
        _mint(_addr, _vpDiff);
    }

    /**
     * Splits one lock into two. The new one gets an own id.
     * Moves also the minted amounts
     * @param _addr user
     * @param _amount Amount to move from original lock to new one
     * @param _id id of locked amount to move
     */
    function _splitLock(
        address _addr,
        uint256 _amount,
        uint256 _id,
        address _recipient
    ) internal returns (uint256 _newId) {
        LockedBalance storage _lock = lockedPositions[_addr][_id];
        require(_lock.amount - _amount >= minLockedAmount, "< min amount for existing lock");
        uint256 _vp = _lock.minted;
        uint256 _vpNew = _shareOf(_vp, _amount, _lock.amount);

        // decrease on old lock
        _lock.amount -= _amount;
        _lock.minted -= _vpNew;

        _newId = _addLock(_recipient, _amount, _vpNew, _lock.start, _lock.end);
    }

    /**
     * Function to increase position for given _id
     * @param _addr user
     * @param _value increase position for position in _id by value
     * @param _id id of the position to increase
     */
    function _increasePosition(
        address _addr,
        uint256 _value,
        uint256 _id
    ) internal {
        uint256 _now = block.timestamp;

        LockedBalance storage _lock = lockedPositions[_msgSender()][_id];

        uint256 _end = _lock.end;

        // calculate amount to mint
        uint256 _vp = getAmountMinted(_value, _now, _end);

        // increase locked amount
        _lock.amount += _value;

        require(_vp > 0, "No benefit to lock");

        IERC20Upgradeable(lockedToken).safeTransferFrom(_msgSender(), address(this), _value);

        _mint(_addr, _vp);
        _lock.minted += _vp;

        // lockedPositions[_msgSender()][_id] = _lock;

        emit Deposit(_addr, _value, _end, _now);
    }

    function _penalize(uint256 _amount) internal {
        ERC20BurnableUpgradeable(lockedToken).burn(_amount);
    }

    /**
     *  Function that logs the recipients lock
     *  All locks will searched and once a match is found the lock amount is added
     *  @param _lock locked amount that is received
     *  @param _recipient recipient address
     *  - does NOT reduce the senders lock, that has to be done before
     */
    function _receiveLock(
        uint256 _id,
        LockedBalance memory _lock,
        address _recipient
    ) internal {
        // assign lock
        lockedPositions[_recipient][_id] = _lock;
        // add maturity entry
        lockIds[_recipient].add(_id);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _addLock(
        address _addr,
        uint256 _amount,
        uint256 _minted,
        uint256 _start,
        uint256 _end
    ) internal returns (uint256 _newId) {
        _newId = lockCount;
        // assign lock for new id
        lockedPositions[_addr][_newId] = LockedBalance({amount: _amount, end: _end, minted: _minted, start: _start});

        // assign id to user
        lockIds[_addr].add(_newId);

        // increase count
        lockCount += 1;
    }

    function _deleteLock(address _addr, uint256 _id) internal {
        // delete lock
        delete lockedPositions[_addr][_id];

        // delete _id entry
        lockIds[_addr].remove(_id);
    }

    /* ========== OVERRIDES ========== */

    function _mint(address account, uint256 amount) internal virtual override(ERC20Upgradeable, ERC20VotesUpgradeable) {
        super._mint(account, amount);
    }

    function _burn(address account, uint256 amount) internal virtual override(ERC20Upgradeable, ERC20VotesUpgradeable) {
        super._burn(account, amount);
    }

    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override(ERC20Upgradeable, ERC20VotesUpgradeable) {
        super._afterTokenTransfer(from, to, amount);
    }

    /* ========== MATH HELPERS ========== */

    function _shareOf(
        uint256 multiplier,
        uint256 a,
        uint256 b
    ) private pure returns (uint256) {
        return (a * multiplier) / b;
    }

    function _weightedSum(
        uint256 a,
        uint256 b,
        uint256 weight_a,
        uint256 weight_b
    ) private pure returns (uint256) {
        return (a * weight_a + b * weight_b) / (weight_a + weight_b);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    /**
     * @notice Allows the governor to set the parameters for locks
     * @param _earlyWithdrawPenaltyRate new penalty rate
     * @param _minLockedAmount new minimum locked amount
     */
    function setParams(uint256 _earlyWithdrawPenaltyRate, uint256 _minLockedAmount) external onlyOwner {
        if (earlyWithdrawPenaltyRate != _earlyWithdrawPenaltyRate) {
            require(_earlyWithdrawPenaltyRate <= MAX_WITHDRAWAL_PENALTY, "penalty too high");
            earlyWithdrawPenaltyRate = _earlyWithdrawPenaltyRate;
            emit EarlyWithdrawPenaltySet(_earlyWithdrawPenaltyRate);
        }

        if (minLockedAmount != _minLockedAmount) {
            minLockedAmount = _minLockedAmount;
            emit MinLockedAmountSet(_minLockedAmount);
        }
    }

    /**
     * @notice Allows the governor to the formula that determines the amount of tokens minted
     * @param _curveProvider new provider
     */
    function setCurveProvider(address _curveProvider) external onlyOwner {
        require(_curveProvider != address(0), "invalid address");
        curveProvider = _curveProvider;
        emit CurveProviderSet(_curveProvider);
    }

    /* =============== EVENTS ==================== */
    event Deposit(address indexed provider, uint256 value, uint256 locktime, uint256 timestamp);
    event Withdraw(address indexed provider, uint256 value, uint256 timestamp);
    event EarlyWithdrawPenaltySet(uint256 indexed penalty);
    event MinLockedAmountSet(uint256 indexed amount);
    event GovernorSet(address indexed governor);
    event CurveProviderSet(address indexed curveProvider);
}
