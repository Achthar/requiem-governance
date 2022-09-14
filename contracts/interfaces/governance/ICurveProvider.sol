// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

interface ICurveProvider {
    function rate(
        uint256 interval,
        uint256 start,
        uint256 end,
        uint256 baseSupply,
        uint256 governanceSupply
    ) external view returns (uint256);

    function forwardRate(
        uint256 interval,
        uint256 current,
        uint256 start,
        uint256 end,
        uint256 baseSupply,
        uint256 governanceSupply
    ) external view returns (uint256);
}
