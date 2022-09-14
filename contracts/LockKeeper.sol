// SPDX-License-Identifier: MIT

pragma solidity ^0.8.17;

import "./libraries/structs/EnumerableSet.sol";
import "./interfaces/governance/ILockKeeper.sol";

// solhint-disable max-line-length

contract LockKeeper is ILockKeeper {
    using EnumerableSet for EnumerableSet.UintSet;

    // counter to generate ids for locks
    uint256 public lockCount;

    // user address -> end times -> locked position
    mapping(address => mapping(uint256 => LockedBalance)) public lockedPositions;

    // tracks the ids for locks per user
    mapping(address => EnumerableSet.UintSet) internal lockIds;

    /* ========== PUBLIC FUNCTIONS ========== */

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
}
