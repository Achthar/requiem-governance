const { ethers } = require('hardhat')
const { addresses } = require('../deployments/addresses')

const GREQArtifact = require('../artifacts/contracts/GovernanceRequiemToken.sol/GovernanceRequiemToken.json')

// deployment script for pricers
async function main() {

    const [operator] = await ethers.getSigners();
    const chainId = await operator.getChainId()

    console.log("initializing proxy:", operator.address);

    console.log("Account balance:", ethers.utils.formatEther(await operator.getBalance()).toString());

    const greqContract = await ethers.getContractAt(GREQArtifact.abi, '0x68fFd3D6b7fcd7a2FfAC923112b99A0a7597102f')

    const symb = await greqContract.symbol()
    const name = await greqContract.name()
    console.log("Symb/name", symb, name)
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });