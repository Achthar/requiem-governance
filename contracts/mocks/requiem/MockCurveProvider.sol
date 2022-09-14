// SPDX-License-Identifier: MIT

pragma solidity ^0.8.17;

import "../../CurveProvider.sol";

/* solhint-disable */

/**
 * @dev Exponentiation and logarithm functions for 18 decimal fixed point numbers (both base and exponent/argument).
 */
contract MockCurveProvider is CurveProvider {
    function ln(int256 x) external pure returns (int256) {
        return YieldMath.ln(x);
    }

    function exp(int256 x) external pure returns (int256) {
        return YieldMath.exp(x);
    }

    function baseRate(
        int256 a,
        int256 t,
        int256 interval
    ) public pure returns (int256) {
        return _baseRate(a, t, interval);
    }
}
