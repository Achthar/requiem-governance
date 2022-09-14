// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

interface IGovernanceLock {
    struct LockedBalance {
        uint256 amount; // locked amount of underlying
        uint256 end; // expriy of position
        uint256 minted; // amount of governance token minted for lock and required to unlock amount
    }

    function getLocks(address _addr) external view returns (LockedBalance[] memory _balances);

    function getVotingPower(address _addr) external view returns (uint256 _votingPower);

    function createLock(
        uint256 _value,
        uint256 _days,
        address _recipient
    ) external;

    function lockExists(address _addr, uint256 _end) external view returns (bool);

    function increasePosition(
        uint256 _value,
        uint256 _end,
        address _recipient
    ) external;

    function increaseTimeToMaturity(
        uint256 _amount,
        uint256 _end,
        uint256 _newEnd
    ) external;

    function withdraw(uint256 _end, uint256 _amount) external;

    function withdrawAll() external;
}
