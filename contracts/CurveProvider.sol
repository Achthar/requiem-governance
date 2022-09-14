// SPDX-License-Identifier: MIT

pragma solidity ^0.8.17;

import "./libraries/math/YieldMath.sol";
import "./interfaces/governance/ICurveProvider.sol";

/* solhint-disable */

/**
 * @dev Exponentiation and logarithm functions for 18 decimal fixed point numbers (both base and exponent/argument).
 */
contract CurveProvider is ICurveProvider {
    int256 public constant FLOOR = 1e17;
    int256 public constant CAP = 9e17;

    /**
     * @notice Calculates the base rate at creation from start (now) to end
     * return an 18-decimal value between 0 and 1
     */
    function rate(
        uint256 interval,
        uint256 start,
        uint256 end,
        uint256 baseSupply,
        uint256 governanceSupply
    ) external pure override returns (uint256) {
        int256 a = calculateGovernanceUtilityCurve(int256(governanceSupply), int256(baseSupply));
        int256 int_t = int256(end - start);
        int256 int_interval = int256(interval);
        return uint256((a * (_baseRate(a, int_t, int_interval) - YieldMath.ONE_18)) / YieldMath.ONE_18);
    }

    /**
     * @notice Calculates the rate from future times start to end at current
     * return an 18-decimal value between 0 and 1
     */
    function forwardRate(
        uint256 interval,
        uint256 current,
        uint256 start,
        uint256 end,
        uint256 baseSupply,
        uint256 governanceSupply
    ) external pure override returns (uint256) {
        int256 a = calculateGovernanceUtilityCurve(int256(governanceSupply), int256(baseSupply));
        int256 int_t0 = int256(start - current);
        int256 int_t1 = int256(end - current);
        int256 int_interval = int256(interval);
        return uint256((a * (_baseRate(a, int_t1, int_interval) - _baseRate(a, int_t0, int_interval))) / YieldMath.ONE_18);
    }

    function _baseRate(
        int256 a,
        int256 t,
        int256 interval
    ) internal pure returns (int256) {
        int256 _b = YieldMath.ln(((YieldMath.ONE_18 + a) * YieldMath.ONE_18) / a);
        return YieldMath.exp((_b * t) / interval);
    }

    function calculateGovernanceUtilityCurve(int256 governanceSupply, int256 lockedSupply) public pure returns (int256) {
        return (YieldMath.ONE_18 * YieldMath.ONE_18) / (FLOOR + (governanceSupply * (CAP - FLOOR)) / lockedSupply);
    }
}
