// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../../interfaces/governance/IVotesRegister.sol";
import "../../token/ERC20/ERC20.sol";

contract MockRegisteredToken is ERC20 {
    IVotesRegister public votesRegister;

    constructor(
        string memory name,
        string memory symbol,
        IVotesRegister register
    ) ERC20(name, symbol) {
        votesRegister = register;
    }

    function getChainId() external view returns (uint256) {
        return block.chainid;
    }

    function mint(address account, uint256 amount) public {
        _mint(account, amount);
        votesRegister.onMint(account, amount);
    }

    function burn(address account, uint256 amount) public {
        _burn(account, amount);
        votesRegister.onBurn(account, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        address owner = _msgSender();
        _transfer(owner, to, amount);
        votesRegister.onAfterTokenTransfer(owner, to, amount);
        return true;
    }

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override returns (bool) {
        address spender = _msgSender();
        _spendAllowance(from, spender, amount);
        _transfer(from, to, amount);
        votesRegister.onAfterTokenTransfer(from, to, amount);
        return true;
    }
}
