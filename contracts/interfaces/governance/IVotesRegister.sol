// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IVotesRegister {
    function onMint(
        address account,
        uint256 amount
    ) external;

    function onBurn(
        address account,
        uint256 amount
    ) external;

    function onAfterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) external;
}
