const { ethers } = require('hardhat')
const { addresses } = require('../deployments/addresses')

const Artifacit = require('../artifacts/contracts/RequiemVotesRegister.sol/RequiemVotesRegister.json')

// deployment script for pricers
async function main() {

    const [operator] = await ethers.getSigners();
    const chainId = await operator.getChainId()

    console.log("initializing proxy:", operator.address);

    console.log("Account balance:", ethers.utils.formatEther(await operator.getBalance()).toString());

    // const logic = "0x09F567c65F6C84Eed019aC9fd25e496e4eBcDc72"

    // const contract = await ethers.getContractAt(Artifacit.abi, '0xE29eFaaD88C8F7C44189d0dE980Eb7b85b147C4D')
    const contract = await ethers.getContractAt(Artifacit.abi, '0xe29efaad88c8f7c44189d0de980eb7b85b147c4d')

    await contract.initialize("Requiem Votes Register")
    console.log("init done")
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });