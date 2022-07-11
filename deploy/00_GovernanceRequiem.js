const { ethers } = require('hardhat')
const { addresses } = require('../deployments/addresses')

// deployment script for pricers
async function main() {

    const [operator] = await ethers.getSigners();
    const chainId = await operator.getChainId()

    console.log("Deploying contracts with the account:", operator.address);

    console.log("Account balance:", ethers.utils.formatEther(await operator.getBalance()).toString());

    const reqAddress = addresses.reqAddress[chainId]

    const CurveProvider = await ethers.getContractFactory('CurveProvider')
    const GovernanceRequiem = await ethers.getContractFactory('GovernanceRequiem')

    const curveProvider = await CurveProvider.deploy()
    const governanceRequiem = await GovernanceRequiem.deploy("Governance Requiem", "gREQ", reqAddress, curveProvider.address, '10000000000000000')

    console.log('CurveProvider:', curveProvider.address)
    console.log('GovernanceRequiem:', governanceRequiem.address)
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });