const { ethers } = require('hardhat')
const { addresses } = require('../deployments/addresses')

const GREQArtifact = require('../artifacts/contracts/GovernanceRequiemToken.sol/GovernanceRequiemToken.json')

// deployment script for pricers
async function main() {

    const [operator] = await ethers.getSigners();
    const chainId = await operator.getChainId()

    console.log("Deploying contracts with the account:", operator.address);

    console.log("Account balance:", ethers.utils.formatEther(await operator.getBalance()).toString());

    const reqAddress = addresses.reqAddress[chainId]

    const CurveProvider = await ethers.getContractFactory('CurveProvider')
    const GovernanceRequiem = await ethers.getContractFactory('GovernanceRequiemToken')
    const TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')
    const ProxyAdmin = await ethers.getContractFactory('ProxyAdmin')

    console.log("deploy Admin")
    const admin = await ProxyAdmin.deploy()

    console.log("deploy curve provider")
    const curveProvider = await CurveProvider.deploy()

    console.log("deploy governance logic")
    const governanceRequiem = await GovernanceRequiem.deploy()

    console.log("deploy Proxy")
    const proxy = await TransparentUpgradeableProxy.deploy(governanceRequiem.address, admin.address, Buffer.from(""))


    const greqContract = await ethers.getContractAt(GREQArtifact.abi, proxy.address)

    await greqContract.initialize("Governance Requiem", "GREQ", reqAddress, curveProvider.address, ethers.BigNumber.from(10).pow(16))

    console.log('CurveProvider:', curveProvider.address)
    console.log('GovernanceRequiem:', governanceRequiem.address)
    console.log("Admin", admin.address)
    console.log("Proxy", proxy.address)
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });