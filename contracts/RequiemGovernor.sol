// SPDX-License-Identifier: MIT

pragma solidity ^0.8.17;

import "./Governor.sol";
import "./utils/IVotes.sol";
import "./interfaces/IERC20.sol";
import "./access/Ownable.sol";
import "./compatibility/GovernorCompatibilityBravo.sol";
import "./extensions/GovernorVotes.sol";
import "./extensions/GovernorVotesQuorumFraction.sol";
import "./extensions/GovernorTimelockControl.sol";

// solhint-disable max-line-length

contract RequiemGovernor is Ownable, Governor, GovernorCompatibilityBravo, GovernorVotes, GovernorVotesQuorumFraction, GovernorTimelockControl {
    uint256 private _votingDelay;
    uint256 private _votingPeriod;
    uint256 private _proposalThreshold;

    constructor(IVotes _requiemShare, TimelockController _timelock)
        Governor("RequiemGovernor")
        GovernorVotes(_requiemShare)
        GovernorVotesQuorumFraction(4)
        GovernorTimelockControl(_timelock)
        Ownable()
    {}

    function votingDelay() public view override returns (uint256) {
        return _votingDelay;
    }

    function votingPeriod() public view override returns (uint256) {
        return _votingPeriod;
    }

    function proposalThreshold() public view override returns (uint256) {
        return _proposalThreshold;
    }

    function setVotingDelay(uint256 _delay) public onlyOwner {
        _votingDelay = _delay;
    }

    function setVotingPeriod(uint256 _period) public onlyOwner {
        _votingPeriod = _period;
    }

    function setProposalThreshold(uint256 _threshold) public onlyOwner {
        _proposalThreshold = _threshold;
    }

    // The functions below are overrides required by Solidity.

    function quorum(uint256 blockNumber) public view override(IGovernor, GovernorVotesQuorumFraction) returns (uint256) {
        return super.quorum(blockNumber);
    }

    function getVotes(address account, uint256 blockNumber) public view override(IGovernor, Governor) returns (uint256) {
        return _getVotes(account, blockNumber, "");
    }

    function state(uint256 proposalId) public view override(Governor, IGovernor, GovernorTimelockControl) returns (ProposalState) {
        return super.state(proposalId);
    }

    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) public override(Governor, GovernorCompatibilityBravo, IGovernor) returns (uint256) {
        return super.propose(targets, values, calldatas, description);
    }

    function _execute(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._execute(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }

    function supportsInterface(bytes4 interfaceId) public view override(Governor, IERC165, GovernorTimelockControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _getVotes(
        address account,
        uint256,
        bytes memory
    ) internal view override(Governor, GovernorVotes) returns (uint256) {
        address tokenAddress = address(token);
        return IVotes(tokenAddress).getVotes(account);
    }
}
