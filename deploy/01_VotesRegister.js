const { ethers } = require('hardhat')
const { addresses } = require('../deployments/addresses')

const RegisterArtifact = require('../artifacts/contracts/RequiemVotesRegister.sol/RequiemVotesRegister.json')

// deployment script for pricers
async function main() {

    const [operator] = await ethers.getSigners();
    const chainId = await operator.getChainId()

    console.log("Deploying contracts with the account:", operator.address);

    console.log("Account balance:", ethers.utils.formatEther(await operator.getBalance()).toString());


    const Register = await ethers.getContractFactory('RequiemVotesRegister')
    const TransparentUpgradeableProxy = await ethers.getContractFactory('TransparentUpgradeableProxy')
    const ProxyAdmin = await ethers.getContractFactory('ProxyAdmin')

    console.log("deploy Admin")
    const admin = await ProxyAdmin.deploy()

    console.log("deploy register logic")
    const registerLogic = await Register.deploy()

    console.log("deploy Proxy")
    const proxy = await TransparentUpgradeableProxy.deploy(registerLogic.address, admin.address, Buffer.from(""))

    const registerContract = await ethers.getContractAt(RegisterArtifact.abi, proxy.address)

    console.log("init proxy")
    await registerContract.initialize("Requiem Votes Register")

    console.log('Register logic:', registerLogic.address)
    console.log("Admin", admin.address)
    console.log("Proxy", proxy.address)
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });