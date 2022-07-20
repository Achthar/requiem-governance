// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "../../GovernanceRequiemToken.sol";

contract GovernanceRequiemTokenMock is GovernanceRequiemToken {
    
    function mint(address account, uint256 amount) public {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) public {
        _burn(account, amount);
    }

    function getChainId() external view returns (uint256) {
        return block.chainid;
    }
}
