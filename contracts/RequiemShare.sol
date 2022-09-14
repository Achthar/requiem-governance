// SPDX-License-Identifier: MIT

pragma solidity ^0.8.17;

import "./token/ERC20/extensions/ERC20Burnable.sol";
import "./token/ERC20/extensions/ERC20Votes.sol";
import "./token/ERC20/utils/SafeERC20.sol";
import "./libraries/math/YieldCalculator.sol";
import "./libraries/structs/EnumerableSet.sol";
import "./interfaces/governance/IGovernanceLock.sol";

// solhint-disable max-line-length

contract RequiemShare is ERC20Votes, ERC20Burnable, IGovernanceLock {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    // flags
    uint256 private _unlocked;

    // constants
    uint256 public constant MAXDAYS = 3 * 365;
    uint256 public constant MAXTIME = MAXDAYS * 1 days; // 3 years
    uint256 public constant MINTIME = 60 * 60; // 1 hour
    uint256 public constant MAX_WITHDRAWAL_PENALTY = 50000; // 50%
    uint256 public constant PRECISION = 100000; // 5 decimals

    address public governor;
    address public lockedToken;
    uint256 public minLockedAmount;
    uint256 public earlyWithdrawPenaltyRate;

    // user address -> end times -> locked position
    mapping(address => mapping(uint256 => LockedBalance)) private lockedPositions;

    // tracks the maturities for locks per user
    mapping(address => EnumerableSet.UintSet) private lockEnds;

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
     * Calculates governance utility rate
     * @return 18-decimal percentage
     */
    function getGovernanceUtility() public view returns (uint256) {
        return _share(this.totalSupply(), IERC20(lockedToken).totalSupply());
    }

    /**
     * Gets lock data for user
     * @param _addr user to get data of
     * @return _balances LockedBalance aray for user
     */
    function getLocks(address _addr) external view override returns (LockedBalance[] memory _balances) {
        uint256 length = lockEnds[_addr].length();
        _balances = new LockedBalance[](length);
        for (uint256 i = 0; i < length; i++) {
            _balances[i] = lockedPositions[_addr][lockEnds[_addr].at(i)];
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

    /**
     * @notice Calculates the total amount of locked tokens for the given user
     * @param _addr user address
     * @return _userAmount the total locked balance for given address
     */
    function getTotalAmountLocked(address _addr) external view returns (uint256 _userAmount) {
        uint256 _length = lockEnds[_addr].length();
        for (uint256 i = 0; i < _length; i++) {
            uint256 _end = lockEnds[_addr].at(i);
            _userAmount += lockedPositions[_addr][_end].amount;
        }
    }

    /**
     * @notice Calculates the total voting power for the given user
     * @param _addr user address
     * @return _votingPower the total voting power for given address
     */
    function getVotingPower(address _addr) external view returns (uint256 _votingPower) {
        uint256 _length = lockEnds[_addr].length();
        for (uint256 i = 0; i < _length; i++) {
            uint256 _end = lockEnds[_addr].at(i);
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
    ) external override lock {
        uint256 _now = block.timestamp;
        uint256 _duration = _end - _now;
        require(_value >= minLockedAmount, "less than min amount");
        require(_duration >= MINTIME, "Shorter than MINTIME");
        require(_duration <= MAXTIME, "Longer than MAXTIME");
        _createLock(_recipient, _value, _end);
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
    ) external lock {
        uint256 _now = block.timestamp;
        uint256 _duration = _newEnd - _now;
        require(_duration >= MINTIME, "Voting lock can MINTIME min");
        require(_duration <= MAXTIME, "Voting lock can MAXTIME max");
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
    ) external lock {
        require(_value >= minLockedAmount, "less than min amount");
        _increasePosition(_recipient, _value, _end);
    }

    /**
     * @notice Withdraws from all locks whenever possible
     */
    function withdrawAll() external override lock {
        uint256 _endsLength = lockEnds[_msgSender()].length();
        for (uint256 i = 0; i < _endsLength; i++) {
            uint256 _end = lockEnds[_msgSender()].at(i);
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
    function withdraw(uint256 _end, uint256 _amount) external override lock {
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
    function emergencyWithdraw(uint256 _end) external lock {
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
    function emergencyWithdrawAll() external lock {
        uint256 _endsLength = lockEnds[_msgSender()].length();
        uint256 _now = block.timestamp;

        for (uint256 i = 0; i < _endsLength; i++) {
            uint256 _end = lockEnds[_msgSender()].at(i);
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
     * @param _end id of lock to transfer
     * @param _to recipient address
     */
    function transferLockShare(
        uint256 _amount,
        uint256 _end,
        address _to
    ) public {
        uint256 _vp = _share(_amount, lockedPositions[_msgSender()][_end].amount);
        LockedBalance memory _lock = lockedPositions[_msgSender()][_end];

        require(_amount < _lock.amount, "Insufficient funds in Lock");

        // adjust lock before transfer
        _lock.amount = _amount;
        _lock.minted = _vp;

        // log the amount for the recipient
        _receiveLock(_lock, _to);

        // reduce this users lock amount
        lockedPositions[_msgSender()][_end].amount -= _amount;

        // reduce related voting power
        lockedPositions[_msgSender()][_end].minted -= _vp;
    }

    /**
     * @dev Function that transfers the full lock of the user to the recipient.
     * @param _end id of lock to transfer
     * @param _to recipient address
     */
    function transferFullLock(uint256 _end, address _to) public {
        LockedBalance memory _lock = lockedPositions[_msgSender()][_end];

        // log the amount for the recipient
        _receiveLock(_lock, _to);

        // reduce this users lock data
        _deleteLock(_msgSender(), _end);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    /**
     * @notice Creates a new governance lock
     */
    function _createLock(
        address _addr,
        uint256 _value,
        uint256 _end
    ) internal {
        require(!_lockExists(_addr, _end), "position exists");
        uint256 _now = block.timestamp;
        uint256 _vp = getAmountMinted(_value, _now, _end);
        require(_vp > 0, "No benefit to lock");

        IERC20(lockedToken).safeTransferFrom(_msgSender(), address(this), _value);
        _mint(_addr, _vp);

        lockEnds[_addr].add(_end);
        lockedPositions[_addr][_end] = LockedBalance({amount: _value, end: _end, minted: _vp});
    }

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
    ) internal {
        uint256 _now = block.timestamp;
        LockedBalance memory _lock = lockedPositions[_addr][_end];
        uint256 _vp = _lock.minted;
        uint256 _vpAdded = getAdditionalAmountMinted(_amount, _now, _lock.end, _newEnd);
        uint256 _newLocked = _lock.amount + _amount;

        uint256 _vpNew;
        // position exists at new maturity
        if (_lockExists(_addr, _newEnd)) {
            LockedBalance memory _lockNew = lockedPositions[_addr][_newEnd];
            uint256 _totalNewMinted = _lockNew.minted + _vpAdded;
            _newLocked = _lockNew.amount + _amount;
            _vpNew = _totalNewMinted >= _newLocked ? _newLocked : _totalNewMinted;
            // increase on new
            _lockNew.amount += _amount;
            _lockNew.minted += _vpNew;

            lockedPositions[_addr][_newEnd] = _lockNew;
        } else {
            // position does not exist

            _vpNew = _vpAdded;
            // add maturity entry
            lockEnds[_addr].add(_newEnd);

            // add lock
            lockedPositions[_addr][_newEnd] = LockedBalance({amount: _amount, minted: _vpNew, end: _newEnd});
        }

        if (_amount == _lock.amount) {
            // delete from old
            _deleteLock(_addr, _end);
        } else {
            // decrease from old
            _lock.amount -= _amount;
            _lock.minted -= _vp;

            lockedPositions[_addr][_end] = _lock;
        }
        uint256 _vpDiff = _vpNew - _vp;
        require(_vpDiff > 0, "No benefit to lock");
        _mint(_addr, _vpDiff);

        emit Deposit(_addr, _amount, _newEnd, _now);
    }

    function _deleteLock(address _addr, uint256 _end) internal {
        // delete lock
        delete lockedPositions[_addr][_end];

        // delete _end entry
        lockEnds[_addr].remove(_end);
    }

    /**
     * Function to increase position for given _end
     * @param _addr user
     * @param _value increase position for position in _end by value
     * @param _end maturity of the position to increase
     */
    function _increasePosition(
        address _addr,
        uint256 _value,
        uint256 _end
    ) internal {
        uint256 _now = block.timestamp;

        // calculate amount to mint
        uint256 _vp = getAmountMinted(_value, _now, _end);

        LockedBalance memory _lock = lockedPositions[_msgSender()][_end];

        // increase locked amount
        _lock.amount += _value;

        require(_vp > 0, "No benefit to lock");

        IERC20(lockedToken).safeTransferFrom(_msgSender(), address(this), _value);

        _mint(_addr, _vp);
        _lock.minted += _vp;

        lockedPositions[_msgSender()][_end] = _lock;

        emit Deposit(_addr, _value, _end, _now);
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
    function _receiveLock(LockedBalance memory _lock, address _recipient) internal {
        uint256 _end = _lock.end;
        if (_lockExists(_recipient, _end)) {
            LockedBalance memory _existingLock = lockedPositions[_recipient][_end];
            _existingLock.minted += _lock.minted;
            _existingLock.amount += _lock.amount;

            lockedPositions[_recipient][_end] = _existingLock;
        } else {
            // assign lock
            lockedPositions[_recipient][_end] = _lock;
            // add maturity entry
            lockEnds[_recipient].add(_end);
        }
    }

    function _lockExists(address _addr, uint256 _end) internal view returns (bool) {
        return lockEnds[_addr].contains(_end);
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

    function _mulDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b) / 1e18;
    }

    function _share(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * 1e18) / b;
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
            require(_earlyWithdrawPenaltyRate <= MAX_WITHDRAWAL_PENALTY, "penalty is high");
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
