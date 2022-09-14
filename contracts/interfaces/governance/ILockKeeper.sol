// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface ILockKeeper {
    struct LockedBalance {
        uint256 amount; // locked amount of underlying
        uint256 start;
        uint256 end; // expriy of position
        uint256 minted; // amount of governance token minted for lock and required to unlock amount
    }

    function getLocks(address _addr) external view returns (LockedBalance[] memory _balances);


    function lockExists(address _addr, uint256 _id) external view returns (bool);

}
