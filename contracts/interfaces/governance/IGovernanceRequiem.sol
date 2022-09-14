// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

interface IGovernanceRequiem {
    function createLock(
        uint256 _value,
        uint256 _days,
        address _recipient
    ) external returns (uint256);

    function increasePosition(
        uint256 _value,
        uint256 _id,
        address _recipient
    ) external;

    function increaseTimeToMaturity(
        uint256 _amount,
        uint256 _id,
        uint256 _newEnd
    ) external returns (uint256);

    function transferLock(
        uint256 _amount,
        uint256 _id,
        address _to,
        bool _sendTokens
    ) external returns (uint256);

    function splitLock(
        uint256 _amount,
        uint256 _id,
        address _recipient
    ) external returns (uint256);

    function mergeLocks(uint256 _firstId, uint256 _secondId) external returns (uint256);

    function withdraw(uint256 _id, uint256 _amount) external;

    function withdrawAll() external;
}
