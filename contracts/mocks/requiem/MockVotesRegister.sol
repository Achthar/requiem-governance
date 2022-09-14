// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../../VotesRegister.sol";
import "../../token/ERC20/ERC20.sol";

contract MockVotesRegister is VotesRegister {
    constructor() VotesRegister() {}

    function getChainId() external view returns (uint256) {
        return block.chainid;
    }
}
