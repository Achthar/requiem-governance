// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "../../interfaces/governance/IVotesRegister.sol";
import "../../token/ERC20/ERC20.sol";

contract MockRegisteredToken is ERC20 {
    IVotesRegister votesRegister;

    constructor(
        string memory name,
        string memory symbol,
        IVotesRegister register
    ) ERC20(name, symbol) {
        votesRegister = register;
    }

    function mint(address account, uint256 amount) public {
        super._mint(account, amount);
        votesRegister.onMint(account, amount);
    }

    function burn(address account, uint256 amount) public {
        super._burn(account, amount);
        votesRegister.onBurn(account, amount);
    }

    function _transfer(
        address from,
        address to,
        uint256 amount
    ) internal override {
        super._transfer(from, to, amount);
        votesRegister.onAfterTokenTransfer(from, to, amount);
    }
}