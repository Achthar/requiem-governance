// SPDX-License-Identifier: MIT

pragma solidity ^0.8.15;

import "./token/ERC20/extensions/ERC20Burnable.sol";
import "./token/ERC20/extensions/ERC20Votes.sol";
import "./token/ERC20/utils/SafeERC20.sol";
import "./libraries/math/YieldCalculator.sol";
import "./libraries/structs/EnumerableSet.sol";
import "./interfaces/governance/IGovernanceRequiem.sol";
import "./LockKeeper.sol";

// solhint-disable max-line-length

contract GovernanceRequiem is IGovernanceRequiem, ERC20Votes, ERC20Burnable, LockKeeper {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    // flags
    uint256 private _unlocked;

    // constants

    uint256 public constant MAXTIME = 365 * 1 days;
    uint256 public constant MINTIME = 60 * 60;
    uint256 public constant MAX_WITHDRAWAL_PENALTY = 50000; // 50%
    uint256 public constant PRECISION = 100000; // 5 decimals

    address public governor;
    address public lockedToken;
    uint256 public minLockedAmount;
    uint256 public earlyWithdrawPenaltyRate;

    /* ========== MODIFIERS ========== */

    modifier lock() {
        require(_unlocked == 1, "LOCKED");
        _unlocked = 0;
        _;
        _unlocked = 1;
    }

    modifier onlyGovernor() {
        require(_msgSender() == governor, "only Governance");
        _;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        address _lockedToken,
        uint256 _minLockedAmount
    ) ERC20(_name, _symbol) ERC20Permit(_name) {
        lockedToken = _lockedToken;
        minLockedAmount = _minLockedAmount;
        earlyWithdrawPenaltyRate = 30000; // 30%
        _unlocked = 1;
        governor = _msgSender();
    }

    /* ========== PUBLIC FUNCTIONS ========== */

    /**
     * @notice Calculates governance utility rate.
     * @return 18-decimal percentage
     */
    function getGovernanceUtility() public view returns (uint256) {
        return _share(this.totalSupply(), IERC20(lockedToken).totalSupply());
    }

    /**
     * @notice Calculates the total amount of locked tokens for the given user
     * @param _addr user address
     * @return _userAmount the total locked balance for given address
     */
    function getTotalAmountLocked(address _addr) external view returns (uint256 _userAmount) {
        for (uint256 i = 0; i < lockIds[_addr].length(); i++) {
            uint256 _end = lockIds[_addr].at(i);
            _userAmount += lockedPositions[_addr][_end].amount;
        }
    }

    /**
     * @notice Calculates the total voting power for the given user
     * @param _addr user address
     * @return _votingPower the total voting power for given address
     */
    function getVotingPower(address _addr) external view returns (uint256 _votingPower) {
        for (uint256 i = 0; i < lockIds[_addr].length(); i++) {
            uint256 _end = lockIds[_addr].at(i);
            _votingPower += lockedPositions[_addr][_end].minted;
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
        return _mulDiv(YieldCalculator.rate(MAXTIME, _startTime, _unlockTime, getGovernanceUtility()), _value);
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
        if (_unlockTime - _startTime > MAXTIME) return _value;
        return _mulDiv(YieldCalculator.forwardRate(MAXTIME, _now, _startTime, _unlockTime, getGovernanceUtility()), _value);
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
    ) external override {
        uint256 _now = block.timestamp;
        uint256 _duration = _end - _now;
        require(_value >= minLockedAmount, "< min amount");
        require(_duration >= MINTIME, "< MINTIME");
        require(_duration <= MAXTIME, "> MAXTIME");

        uint256 _vp = getAmountMinted(_value, _now, _end);
        require(_vp > 0, "No benefit to lock");

        IERC20(lockedToken).safeTransferFrom(_msgSender(), address(this), _value);
        _mint(_recipient, _vp);

        _addLock(_recipient, _value, _vp, _now, _end);
    }

    /**
     * Increases the maturity of _amount from _end to _newEnd
     * @param _amount amount to change the maturity for
     * @param _end maturity
     * @param _newEnd new maturity
     */
    function increaseTimeToMaturity(
        uint256 _amount,
        uint256 _end,
        uint256 _newEnd
    ) external override {
        uint256 _now = block.timestamp;
        uint256 _duration = _newEnd - _now;
        require(_duration >= MINTIME, "< MINTIME");
        require(_duration <= MAXTIME, "> MAXTIME");
        _extendMaturity(_msgSender(), _amount, _end, _newEnd);
    }

    /**
     * Function to increase position for given _end
     * @param _value increase position for position in _end by value
     * @param _end maturity of the position to increase
     * @param _recipient add funds for given user
     */
    function increasePosition(
        uint256 _value,
        uint256 _end,
        address _recipient
    ) external override {
        require(_value >= minLockedAmount, "< min amount");
        _increasePosition(_recipient, _value, _end);
    }

    /**
     * @notice Merges two locks of the user. The one with the lower maturity will be extended to match the other.
     */
    function mergeLocks(uint256 _firstId, uint256 _secondId) external override {
        (uint256 _lateId, uint256 _earlyId) = lockedPositions[_msgSender()][_firstId].end >= lockedPositions[_msgSender()][_secondId].end
            ? (_firstId, _secondId)
            : (_secondId, _firstId);

        LockedBalance memory _earlyLock = lockedPositions[_msgSender()][_earlyId];
        require(_lockExists(_msgSender(), _secondId) && _lockExists(_msgSender(), _firstId), "nothing to merge");
        LockedBalance storage _lateLock = lockedPositions[_msgSender()][_lateId];

        uint256 _earlyAmount = _earlyLock.amount;
        uint256 _lateAmount = _lateLock.amount;

        // calculate extended amount for old lock
        uint256 _vpDiff = getAdditionalAmountMinted(_earlyAmount, block.timestamp, _earlyLock.end, _lateLock.end);
        uint256 _totalAmount = _earlyLock.amount + _lateAmount;
        uint256 _totalMinted = _earlyLock.minted + _lateLock.minted + _vpDiff;

        // make sure the minted governance tokens are capped
        _lateLock.minted = _totalMinted > _totalAmount ? _totalAmount : _totalMinted;

        _lateLock.start = _weightedSum(_lateLock.start, _earlyLock.start, _lateAmount, _earlyAmount);

        _mint(_msgSender(), _vpDiff);
        _deleteLock(_msgSender(), _earlyId);
    }

    /**
     * @notice Withdraws from all locks whenever possible
     */
    function withdrawAll() external {
        for (uint256 i = 0; i < lockIds[_msgSender()].length(); i++) {
            uint256 _end = lockIds[_msgSender()].at(i);
            LockedBalance storage _lock = lockedPositions[_msgSender()][_end];
            uint256 _locked = _lock.amount;
            uint256 _now = block.timestamp;
            if (_locked > 0 && _now >= _end) {
                uint256 _minted = _lock.minted;

                // burn minted amount
                _burn(_msgSender(), _minted);

                // delete lock entry
                _deleteLock(_msgSender(), _end);

                IERC20(lockedToken).safeTransfer(_msgSender(), _locked);

                emit Withdraw(_msgSender(), _locked, _now);
            }
        }
    }

    /**
     * @notice Withdraws from specific lock if possible
     * @param _end maturity of the position to increase
     * @param _amount amount to withdraw fromn lock
     */
    function withdraw(uint256 _end, uint256 _amount) external {
        LockedBalance storage _lock = lockedPositions[_msgSender()][_end];
        uint256 _now = block.timestamp;
        uint256 _locked = _lock.amount;
        require(_locked > 0, "Nothing to withdraw");
        require(_now >= _end, "The lock didn't expire");
        if (_amount >= _locked) {
            uint256 _minted = _lock.minted;

            // burn minted amount
            _burn(_msgSender(), _minted);

            // delete lock entry
            _deleteLock(_msgSender(), _end);
        } else {
            uint256 _minted = _share(_amount, _locked);
            _lock.amount -= _amount;
            _lock.minted -= _minted;
            _burn(_msgSender(), _minted);
        }

        IERC20(lockedToken).safeTransfer(_msgSender(), _amount);

        emit Withdraw(_msgSender(), _amount, _now);
    }

    /**
     * @notice Withdraws from specific lock - this will charge PENALTY if lock is not expired yet.
     * @param _end maturity of the position to increase
     */
    function emergencyWithdraw(uint256 _end) external {
        LockedBalance memory _lock = lockedPositions[_msgSender()][_end];
        uint256 _amount = _lock.amount;
        uint256 _now = block.timestamp;
        require(_amount > 0, "Nothing to withdraw");
        if (_now < _end) {
            uint256 _fee = (_amount * earlyWithdrawPenaltyRate) / PRECISION;
            _penalize(_fee);
            _amount -= _fee;
        }

        // burn amount
        _burn(_msgSender(), _lock.minted);

        // remove lock
        _deleteLock(_msgSender(), _end);

        IERC20(lockedToken).safeTransfer(_msgSender(), _amount);

        emit Withdraw(_msgSender(), _amount, _now);
    }

    /**
     * @notice Withdraws from all locks available for user - this will charge PENALTY if lock is not expired yet.
     */
    function emergencyWithdrawAll() external {
        uint256 _now = block.timestamp;
        for (uint256 i = 0; i < lockIds[_msgSender()].length(); i++) {
            uint256 _end = lockIds[_msgSender()].at(i);
            LockedBalance memory _lock = lockedPositions[_msgSender()][_end];
            uint256 _locked = _lock.amount;
            if (_locked > 0) {
                if (_now < _end) {
                    uint256 _fee = (_locked * earlyWithdrawPenaltyRate) / PRECISION;
                    _penalize(_fee);
                    _locked -= _fee;
                }

                _burn(_msgSender(), _lock.minted);

                // delete lock
                _deleteLock(_msgSender(), _end);

                IERC20(lockedToken).safeTransfer(_msgSender(), _locked);

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
    function transferLockShare(
        uint256 _amount,
        uint256 _id,
        address _to
    ) external override {
        LockedBalance memory _lock = lockedPositions[_msgSender()][_id];
        uint256 _vp = _share(_amount, _lock.amount);

        require(_amount < _lock.amount, "Insufficient funds in Lock");

        // adjust lock before transfer
        _lock.amount = _amount;
        _lock.minted = _vp;

        // log the amount for the recipient - create new lock
        _receiveLock(lockCount, _lock, _to);
        // increase count
        lockCount += 1;

        // reduce this users lock amount
        lockedPositions[_msgSender()][_id].amount -= _amount;

        // reduce related voting power
        lockedPositions[_msgSender()][_id].minted -= _vp;
    }

    /**
     * @dev Function that transfers the full lock of the user to the recipient.
     * @param _id id of lock to transfer
     * @param _to recipient address
     */
    function transferFullLock(uint256 _id, address _to) external override {
        LockedBalance memory _lock = lockedPositions[_msgSender()][_id];

        // log the amount for the recipient
        _receiveLock(_id, _lock, _to);

        // reduce this users lock data
        _deleteLock(_msgSender(), _id);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    /**
     * Extends the maturity
     * Moves also the minted amounts
     * @param _addr user
     * @param _amount Amount to move from old end to end
     * @param _end end of locked amount to move
     * @param _newEnd target end
     */
    function _extendMaturity(
        address _addr,
        uint256 _amount,
        uint256 _end,
        uint256 _newEnd
    ) internal lock {
        LockedBalance storage _lock = lockedPositions[_addr][_end];
        uint256 _vp = _lock.minted;
        uint256 _vpAdded = getAdditionalAmountMinted(_amount, block.timestamp, _lock.end, _newEnd);
        uint256 _newLocked = _lock.amount + _amount;

        uint256 _totalNewMinted = _vp + _vpAdded;
        _newLocked = _lock.amount + _amount;
        uint256 _vpNew = _totalNewMinted >= _newLocked ? _newLocked : _totalNewMinted;

        // increase on new
        _lock.amount += _amount;
        _lock.minted += _vpNew;

        uint256 _vpDiff = _vpNew - _vp;
        require(_vpDiff > 0, "No benefit to lock");
        _mint(_addr, _vpDiff);
    }

    /**
     * Function to increase position for given _end
     * @param _addr user
     * @param _value increase position for position in _end by value
     * @param _id id of the position to increase
     */
    function _increasePosition(
        address _addr,
        uint256 _value,
        uint256 _id
    ) internal lock {
        uint256 _now = block.timestamp;

        // calculate amount to mint
        uint256 _vp = getAmountMinted(_value, _now, _id);

        LockedBalance storage _lock = lockedPositions[_msgSender()][_id];

        // increase locked amount
        _lock.amount += _value;

        require(_vp > 0, "No benefit to lock");

        IERC20(lockedToken).safeTransferFrom(_msgSender(), address(this), _value);

        _mint(_addr, _vp);
        _lock.minted += _vp;

        lockedPositions[_msgSender()][_id] = _lock;

        emit Deposit(_addr, _value, _id, _now);
    }

    function _penalize(uint256 _amount) internal {
        ERC20Burnable(lockedToken).burn(_amount);
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
    ) internal lock {
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
    ) internal lock {
        // assign lock for new id
        lockedPositions[_addr][lockCount] = LockedBalance({amount: _amount, end: _end, minted: _minted, start: _start});

        // assign id to user
        lockIds[_addr].add(lockCount);

        // increase count
        lockCount += 1;
    }

    function _deleteLock(address _addr, uint256 _id) internal lock {
        // delete lock
        delete lockedPositions[_addr][_id];

        // delete _id entry
        lockIds[_addr].remove(_id);
    }

    /* ========== OVERRIDES ========== */

    function _mint(address account, uint256 amount) internal virtual override(ERC20, ERC20Votes) {
        super._mint(account, amount);
    }

    function _burn(address account, uint256 amount) internal virtual override(ERC20, ERC20Votes) {
        super._burn(account, amount);
    }

    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual override(ERC20, ERC20Votes) {
        super._afterTokenTransfer(from, to, amount);
    }

    /* ========== MATH HELPERS ========== */

    function _mulDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return (a * b) / 1e18;
    }

    function _share(uint256 a, uint256 b) private pure returns (uint256) {
        return (a * 1e18) / b;
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

    function setGovernor(address _newGovernor) external onlyGovernor {
        governor = _newGovernor;
        emit GovernorSet(_newGovernor);
    }

    /**
     * @notice Allows the governor to set the parameters for locks
     * @param _earlyWithdrawPenaltyRate new penalty rate
     * @param _minLockedAmount new minimum locked amount
     */
    function setParams(uint256 _earlyWithdrawPenaltyRate, uint256 _minLockedAmount) external onlyGovernor {
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

    /* =============== EVENTS ==================== */
    event Deposit(address indexed provider, uint256 value, uint256 locktime, uint256 timestamp);
    event Withdraw(address indexed provider, uint256 value, uint256 timestamp);
    event EarlyWithdrawPenaltySet(uint256 indexed penalty);
    event MinLockedAmountSet(uint256 indexed amount);
    event GovernorSet(address indexed governor);
}
