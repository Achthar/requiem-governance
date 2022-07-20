const { ethers } = require('hardhat')
const { addresses } = require('../deployments/addresses')

const GREQArtifact = require('../artifacts/contracts/GovernanceRequiemToken.sol/GovernanceRequiemToken.json')

// deployment script for pricers
async function main() {

    const [operator] = await ethers.getSigners();
    const chainId = await operator.getChainId()

    console.log("initializing proxy:", operator.address);

    console.log("Account balance:", ethers.utils.formatEther(await operator.getBalance()).toString());

    const reqAddress = addresses.reqAddress[chainId]


    const greqContract = await ethers.getContractAt(GREQArtifact.abi, '0x68fFd3D6b7fcd7a2FfAC923112b99A0a7597102f')

    await greqContract.initialize("Governance Requiem", "GREQ", reqAddress, '0x1da345f77DC1d415c7a49890E0798f59e4e39539', ethers.BigNumber.from(10).pow(16))
    console.log("init done")
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });