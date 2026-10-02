// Common given names, lowercase and ASCII-folded, across the markets the feed covers. The only use
// is telling an angel ("Jeff Hammerbacher") from a firm named like a person ("Kleiner Perkins"):
// a two-to-four-word name whose first word is here is read as a person unless a firm's own site
// says otherwise. Names that are also brands ("Morgan", "Franklin") stay in; the firm still
// resolves, it only has to prove it on its homepage.

const NAMES = `
aaron abby abdul abdullah abe abhay abhishek abigail abraham adam adi aditi aditya adrian adriana
adrien agnes ahmad ahmed aidan aisha ajay akash akhil akira akshay al alan alba albert alberto
alejandro alessandro alex alexa alexander alexandra alexandre alexis alfonso alfred ali alice
alicia alison allen allison alok alvaro amanda amar amber amir amit amy ana anand ananya anders
andre andrea andreas andres andrew andy angela angelo anil anish anita anja ankit ankur ann anna
anne annie anthony anton antonio anu anuj anupam anurag april archie ari ariel arjun arnaud arnav
arthur arun arvind asaf ash asha ashish ashley ashok ashwin astrid audrey austin ava avi avinash
axel ayesha barbara barry bart ben benedict benjamin benoit bernard beth bethany bill billy bjorn
blake bob bobby brad bradley brandon brendan brent brett brian bridget brittany bruce bruno bryan
caitlin caleb calvin cameron camille carl carla carlos carmen carol caroline carolyn carrie casey
catherine cecilia cedric celine chad chan chandra charles charlie charlotte chase chen cheryl chetan
chris christian christina christine christoph christophe christopher chuck cindy claire clara
clare claudia clement cliff clint cody colin connor constantin cora corey cory craig cristina
curtis cyril dale dalia dan dana daniel daniela danielle danny darius darren dave david dean
deborah deepak deepika denis dennis derek devin dheeraj dhruv diana diane diego dieter dimitri
dinesh dirk divya dmitry dominic dominik don donald donna doug douglas drew duncan dustin dylan
ed eddie edgar edward edwin eileen elad elena eli elias elijah elisa elizabeth ella ellen elliot
elliott emil emilia emily emma enrico eric erica erik erin esther ethan eugene eva evan eve
fabian fabio faisal farah farhan fatima federico felipe felix fernando filip filippo fiona florian
frances francesca francesco francis francisco franck frank franklin franz fred frederic frederick
gabriel gabriela gabrielle gaurav gautam gavin gene geoff geoffrey george georg gerald gerard
gerardo gianluca gil gilles gina giovanni giulia glen glenn gordon gokul grace graham grant greg
gregory guillaume gunnar gustavo guy hamza hana hannah hans harish harold harry harsh harvey hassan
heather hector heidi helen helena henri henrik henry hiroshi hitesh holly howard hugh hugo hussein
ian ibrahim igor ilan ilya imran ines ingrid irene isaac isabel isabella isabelle ishaan ivan jack
jackie jacob jacqueline jacques jai jake james jamie jan jana jane janet janice jared jasmine jason
javier jay jayesh jean jeff jeffrey jen jenna jennifer jenny jeremy jerome jerry jess jesse jessica
jill jim jimmy jin jo joan joanna joe joel johan johann johannes john johnny jon jonas jonathan
jordan jorge jose josef joseph josh joshua juan judith judy julia julian juliana julie julien
julio june justin kai kamal kapil karan karen karim karl kate katherine kathleen kathryn kathy
katie katrin kavya keith kelly ken kenji kenneth kevin khalid kim kimberly kirk kiran klaus kris
krishna kristen kristin kumar kunal kurt kyle lakshmi lance lara larry laura lauren laurent
lawrence leah lee lena leo leon leonard leonardo lewis liam lily lin linda lisa liz logan lorenzo
louis louise luca lucas lucia luis luke lukas madhav madison magnus mahesh manish manoj manuel
marc marcel marco marcus margaret maria marie marina mario mark markus marta martin mary mathieu
matt matteo matthew matthias matthieu max maxime maximilian maya megan mehdi mei melanie melissa
meredith mia michael michel michelle miguel mike mikhail mila miles milan min mira miranda mitch
mohamed mohammad mohammed mohit monica morgan moritz muhammad murali nadia nancy naomi nat natalia
natalie nathan nathaniel naveen navin neal neel neha neil nelson nick nicholas nicola nicolas
nicole niels nikhil nikita nikolai nils nina nisha nitin noah noel nora olga oliver olivia omar
omri oren oscar otto owen pablo paolo parag paris pascal patricia patrick paul paula pavel pedro
per peter philip philipp philippe pierre pooja prakash pranav prashant prateek pratik praveen
preeti prem priya priyanka rachel rafael rahul raj rajat rajeev rajesh rajiv ralph ram ramesh
rami ramon rana randy raphael rashid raul ravi ray raymond rebecca reed reid remi renata rene
rhys ricardo richard rick rishi rita rob robert roberto robin rodrigo rohan rohit roland roman
ron ronald rory rosa ross roy ruben rupert russell ruth ryan sachin sagar sahil sai sally sam
samantha sameer samir samuel sandeep sandra sanjay santiago sara sarah sasha satish saurabh scott
sean sebastian serena sergey sergio seth shahid shane shankar sharon shaun shawn sheila shira
shiv shreya shubham siddharth simon simone sofia sonia sophia sophie srinath stacy stefan stefano
stephan stephanie stephen steve steven stuart sudhir sujay sumit sunil suresh susan suzanne sven
tamar tanya tara ted teresa terri terry thea theo theodore thierry thomas tim timothy tina toby
todd tom tomas tommy tony tracy travis trevor tyler uday uma umar uri valentin valeria vanessa
varun venkat vera veronica victor victoria vijay vikas vikram vincent vinod vipul virginia vishal
vivek vlad vladimir walter warren wei wendy wesley will william wolfgang xavier yael yan yang
yann yash yasmin yoav yogesh yosef yuri yusuf yves zach zachary zoe
`;

/** The set, built once. */
export const GIVEN_NAMES: ReadonlySet<string> = new Set(NAMES.split(/\s+/).filter(Boolean));
