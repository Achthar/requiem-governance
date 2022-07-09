// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.15;

interface IGovernanceRequiem {
    function createLock(
        uint256 _value,
        uint256 _days,
        address _recipient
    ) external;

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

    function transferFullLock(uint256 _id, address _to) external;

    function transferLockShare(
        uint256 _amount,
        uint256 _id,
        address _to
    ) external;

    function mergeLocks(uint256 _firstId, uint256 _secondId) external;

    function withdraw(uint256 _end, uint256 _amount) external;

    function withdrawAll() external;
}
